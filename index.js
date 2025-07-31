// index.js (ESM module)
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { convertToOutbounds } from 'singbox-converter';
import fetch from 'node-fetch';

const exec = promisify(require('child_process').exec);

const LINKS_FILE = 'links.txt';
const TEST_URL = 'https://ip.oxylabs.io/location';
const PROXY_ADDRESS = 'socks5://127.0.0.1:10808';
const STARTUP_DELAY = 3000; // 3 seconds
const TIMEOUT = 15; // seconds for curl

async function main() {
  try {
    const linksContent = await fs.readFile(LINKS_FILE, 'utf-8');
    const lines = linksContent.trim().split('\n');

    let proxyLinks = [];
    if (lines.length === 1 && (lines[0].startsWith('http://') || lines[0].startsWith('https://'))) {
      // It's a subscription URL
      const response = await fetch(lines[0]);
      if (!response.ok) throw new Error(`Failed to fetch subscription: ${response.statusText}`);
      const subContent = await response.text();
      proxyLinks = subContent.trim().split('\n');
    } else {
      proxyLinks = lines;
    }

    const results = [];
    for (const link of proxyLinks) {
      if (!link.trim()) continue;
      const result = await testProxy(link);
      results.push(result);
    }

    const timestamp = new Date().toISOString();
    const outputFile = `tested${timestamp}.json`;
    await fs.writeFile(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${outputFile}`);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

async function testProxy(link) {
  const name = link.split('#').pop() || 'Unnamed';
  const result = {
    status: 'non-working',
    name,
    full_link: link,
    speedtest: { ping_ms: 'N/A', download_mbps: 'N/A', upload_mbps: 'N/A' },
    location: {},
    error: '',
    timestamp: new Date().toISOString(),
    ip_address: 'N/A',
    country_code: 'N/A',
    city: 'N/A',
    asn_organization: 'N/A',
    asn_number: 'N/A',
    ping_ms: 'N/A',
    download_mbps: 'N/A',
    upload_mbps: 'N/A'
  };

  try {
    // Convert link to sing-box outbound
    const outbounds = await convertToOutbounds(link);
    if (!outbounds || outbounds.length === 0) throw new Error('Failed to convert to outbound');

    const outbound = outbounds[0];
    outbound.tag = name; // Ensure tag is set

    // Generate full sing-box config
    const config = generateSingboxConfig(outbound);
    const configPath = path.join('/tmp', `${Date.now()}.json`);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    // Run sing-box
    const singboxProcess = spawn('sing-box', ['run', '-c', configPath]);
    await new Promise(resolve => setTimeout(resolve, STARTUP_DELAY));

    // Perform tests
    const testResults = [];
    for (let i = 0; i < 3; i++) {
      const { success, data, ping, error } = await performCurlTest();
      testResults.push({ success, data, ping, error });
      if (i === 0) continue; // First is warm-up, not counted for data
    }

    // Analyze results
    const successes = testResults.filter(r => r.success).length;
    const finalResult = testResults[testResults.length - 1]; // Last successful or the third

    if (successes >= 2) {
      result.status = 'working';
      if (finalResult.success) {
        result.location = finalResult.data;
        result.ping_ms = finalResult.ping;
        result.ip_address = finalResult.data.ip || 'N/A';
        result.country_code = Object.values(finalResult.data.providers).reduce((acc, p) => acc || p.country, 'N/A');
        result.city = Object.values(finalResult.data.providers).reduce((acc, p) => acc || p.city, 'N/A');
        result.asn_organization = Object.values(finalResult.data.providers).reduce((acc, p) => acc || p.org_name, 'N/A');
        result.asn_number = Object.values(finalResult.data.providers).reduce((acc, p) => acc || p.asn, 'N/A');
      }

      // Measure speedtest if working
      const speedtestResult = await performSpeedtest();
      result.speedtest = speedtestResult;
      result.download_mbps = speedtestResult.download_mbps;
      result.upload_mbps = speedtestResult.upload_mbps;
    } else {
      result.status = 'non-working';
      result.error = finalResult.error || 'Multiple test failures';
    }

    singboxProcess.kill();
    await fs.unlink(configPath);
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

async function performCurlTest() {
  try {
    const { stdout } = await exec(`curl -s -x ${PROXY_ADDRESS} --max-time ${TIMEOUT} -w "%{time_starttransfer}" ${TEST_URL}`);
    const [response, time_starttransfer] = stdout.split(/(?={)/); // Split on JSON start
    const data = JSON.parse(response);
    const ping = (parseFloat(time_starttransfer) * 1000).toFixed(0);
    return { success: true, data, ping, error: null };
  } catch (err) {
    return { success: false, data: null, ping: 'N/A', error: err.message };
  }
}

async function performSpeedtest() {
  try {
    const { stdout } = await exec(`ALL_PROXY=${PROXY_ADDRESS} speedtest-cli --simple --timeout 45`);
    const lines = stdout.split('\n');
    const ping = lines[0].match(/Ping: ([\d.]+) ms/)?.[1] || 'N/A';
    const download = lines[1].match(/Download: ([\d.]+) Mbit\/s/)?.[1] || 'N/A';
    const upload = lines[2].match(/Upload: ([\d.]+) Mbit\/s/)?.[1] || 'N/A';
    return { ping_ms: ping, download_mbps: download, upload_mbps: upload };
  } catch (err) {
    return { ping_ms: 'N/A', download_mbps: 'N/A', upload_mbps: 'N/A' };
  }
}

function generateSingboxConfig(outbound) {
  return {
    log: { level: 'debug' },
    inbounds: [{
      type: 'socks',
      tag: 'socks-in',
      listen: '127.0.0.1',
      listen_port: 10808,
      sniff: true
    }],
    outbounds: [outbound],
    route: {
      rules: [{ inbound: ['socks-in'], outbound: outbound.tag }]
    }
  };
}

main();
