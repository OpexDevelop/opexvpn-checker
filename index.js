import { readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { convertToOutbounds } from 'singbox-converter';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);
const TEST_URL = 'https://ip.oxylabs.io/location';
const PROXY_PORT = 10808;
const PROXY_ADDRESS = `socks5h://127.0.0.1:${PROXY_PORT}`;
const STARTUP_DELAY = 5000;
const REQUEST_TIMEOUT = 15;

async function readLinks() {
    try {
        const content = await readFile('links.txt', 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());

        if (lines.length === 1 && (lines[0].startsWith('http://') || lines[0].startsWith('https://'))) {
            console.log('Detected subscription URL, fetching...');
            const response = await fetch(lines[0]);
            const subContent = await response.text();

            try {
                const decoded = Buffer.from(subContent, 'base64').toString('utf-8');
                if (decoded.includes('://')) {
                    return decoded.trim().split('\n').filter(line => line.trim());
                }
            } catch (e) {
                // Not base64
            }

            return subContent.trim().split('\n').filter(line => line.trim());
        }

        return lines;
    } catch (error) {
        console.error('Error reading links:', error);
        return [];
    }
}

function createSingboxConfig(outbound, allowInsecure = false) {
    if (allowInsecure && outbound.tls && outbound.tls.enabled) {
        outbound.tls.insecure = true;
    }

    return {
        log: {
            level: "info",
            timestamp: true
        },
        inbounds: [{
            type: "socks",
            tag: "socks-in",
            listen: "127.0.0.1",
            listen_port: PROXY_PORT,
            sniff: true,
            sniff_override_destination: false
        }],
        outbounds: [outbound],
        route: {
            rules: [{
                inbound: ["socks-in"],
                outbound: outbound.tag
            }]
        }
    };
}

function startSingbox(configPath) {
    return new Promise((resolve, reject) => {
        const singbox = spawn('sing-box', ['run', '-c', configPath], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let startupTimeout = setTimeout(() => {
            singbox.kill('SIGKILL');
            reject(new Error('Sing-box startup timeout'));
        }, 20000);

        let started = false;
        const checkStarted = (data) => {
            if (started) return;

            const output = data.toString();
            if (output.includes('started') ||
                output.includes('server started') ||
                output.includes('tcp server started') ||
                output.includes('listening') ||
                output.includes('inbound/socks')) {
                started = true;
                clearTimeout(startupTimeout);
                setTimeout(() => resolve(singbox), STARTUP_DELAY);
            }
        };

        singbox.stdout.on('data', checkStarted);
        singbox.stderr.on('data', (data) => {
            const error = data.toString();
            checkStarted(data);

            if (error.includes('FATAL') || error.includes('panic')) {
                clearTimeout(startupTimeout);
                singbox.kill('SIGKILL');
                reject(new Error(`Sing-box error: ${error}`));
            }
        });

        singbox.on('error', (err) => {
            clearTimeout(startupTimeout);
            reject(err);
        });

        singbox.on('exit', (code, signal) => {
            clearTimeout(startupTimeout);
            if (code !== 0 && code !== null && !started) {
                reject(new Error(`Sing-box exited with code ${code}`));
            }
        });

        setTimeout(() => {
            if (!started && startupTimeout) {
                try {
                    process.kill(singbox.pid, 0);
                    started = true;
                    clearTimeout(startupTimeout);
                    setTimeout(() => resolve(singbox), STARTUP_DELAY);
                } catch (e) {
                    // Process not running
                }
            }
        }, 3000);
    });
}

async function makeProxyRequest() {
    try {
        const curlCommand = `curl -s --proxy "${PROXY_ADDRESS}" --max-time ${REQUEST_TIMEOUT} -w "\\n---STATS---\\nHTTP_CODE:%{http_code}\\nLATENCY_S:%{time_starttransfer}" "${TEST_URL}"`;

        const { stdout, stderr } = await exec(curlCommand);

        if (stderr) {
            throw new Error(stderr);
        }

        const parts = stdout.split('---STATS---');
        const responseBody = parts[0].trim();
        const stats = parts[1] || '';

        const httpCode = stats.match(/HTTP_CODE:(\d+)/)?.[1] || '0';
        const latencyS = stats.match(/LATENCY_S:([\d.]+)/)?.[1] || '0';

        if (httpCode !== '200') {
            throw new Error(`HTTP ${httpCode}`);
        }

        let data;
        try {
            data = JSON.parse(responseBody);
        } catch (e) {
            throw new Error('Invalid JSON response');
        }

        return {
            success: true,
            data: data,
            latency: parseFloat(latencyS) * 1000
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

async function testProxyWithSettings(link, index, outbound, allowInsecure) {
    const configFile = `temp_config_${index}_${allowInsecure ? 'insecure' : 'secure'}.json`;
    const config = createSingboxConfig(outbound, allowInsecure);

    try {
        await writeFile(configFile, JSON.stringify(config, null, 2));
    } catch (error) {
        return {
            success: false,
            error: 'Failed to write config: ' + error.message
        };
    }

    let singboxProcess;
    try {
        singboxProcess = await startSingbox(configFile);
    } catch (error) {
        await exec(`rm -f ${configFile}`).catch(() => {});
        return {
            success: false,
            error: 'Sing-box startup failed: ' + error.message
        };
    }

    try {
        await makeProxyRequest();

        const request1 = await makeProxyRequest();
        const request2 = await makeProxyRequest();

        let finalResult;
        let successCount = [request1, request2].filter(r => r.success).length;

        if (successCount === 1) {
            const request3 = await makeProxyRequest();
            successCount = [request1, request2, request3].filter(r => r.success).length;
            finalResult = [request1, request2, request3].find(r => r.success) || request3;
        } else {
            finalResult = request2.success ? request2 : request1;
        }

        const isWorking = successCount >= 2;

        return {
            success: isWorking,
            result: finalResult,
            insecure: allowInsecure,
        };
    } finally {
        if (singboxProcess) {
            try {
                singboxProcess.kill('SIGTERM');
                await new Promise(resolve => setTimeout(resolve, 1000));
                try {
                    process.kill(singboxProcess.pid, 0);
                    singboxProcess.kill('SIGKILL');
                } catch (e) {
                    // Process already dead
                }
            } catch (e) {}
        }
        await exec(`rm -f ${configFile}`).catch(() => {});
    }
}

async function testProxy(link, index) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Testing proxy ${index + 1}: ${link.substring(0, 50)}...`);

    let outbound;
    let name = 'Unknown';

    try {
        const outbounds = await convertToOutbounds(link);
        if (!outbounds || outbounds.length === 0) {
            throw new Error('Failed to convert link to outbound');
        }
        outbound = outbounds[0];
        name = outbound.tag || extractNameFromLink(link) || `Proxy ${index + 1}`;
    } catch (error) {
        console.error('Conversion error:', error.message);
        return createErrorResult(link, 'Conversion failed: ' + error.message, name);
    }

    console.log('Testing with secure mode...');
    let testResult = await testProxyWithSettings(link, index, outbound, false);

    if (!testResult.success && outbound.tls && outbound.tls.enabled) {
        console.log('Secure mode failed, trying with insecure mode...');
        testResult = await testProxyWithSettings(link, index, outbound, true);
    }

    if (testResult.success) {
        console.log(`Proxy is working (insecure: ${testResult.insecure})`);

        const ipData = testResult.result.data || {};
        const providers = ipData.providers || {};

        const country = providers.dbip?.country || providers.ip2location?.country ||
            providers.ipinfo?.country || providers.maxmind?.country || 'N/A';
        const city = providers.dbip?.city || providers.ip2location?.city ||
            providers.ipinfo?.city || providers.maxmind?.city || 'N/A';
        const asn_org = providers.dbip?.org_name || providers.ip2location?.org_name ||
            providers.ipinfo?.org_name || providers.maxmind?.org_name || 'N/A';
        const asn_number = providers.dbip?.asn || providers.ip2location?.asn ||
            providers.ipinfo?.asn || providers.maxmind?.asn || 'N/A';

        return {
            status: 'working',
            name: name,
            full_link: link,
            ip_address: ipData.ip || 'N/A',
            country_code: country,
            city: city,
            asn_organization: asn_org,
            asn_number: asn_number,
            ping_ms: testResult.result.latency?.toFixed(0) || 'N/A',
            insecure: testResult.insecure,
            ip_info_response: ipData,
            timestamp: new Date().toISOString()
        };
    } else {
        console.log('Proxy not working');
        const errorMessage = testResult.error || (testResult.result && testResult.result.error) || 'Unknown test failure';
        return createErrorResult(link, errorMessage, name);
    }
}

function extractNameFromLink(link) {
    const match = link.match(/#(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

function createErrorResult(link, error, name = 'Unknown') {
    return {
        status: 'error',
        name: name,
        full_link: link,
        ip_address: 'N/A',
        country_code: 'N/A',
        city: 'N/A',
        asn_organization: 'N/A',
        asn_number: 'N/A',
        ping_ms: 'N/A',
        insecure: false,
        error: error,
        timestamp: new Date().toISOString()
    };
}

async function main() {
    console.log('Starting proxy tests...');

    const links = await readLinks();
    if (links.length === 0) {
        console.error('No links found in links.txt');
        return;
    }

    console.log(`Found ${links.length} links to test`);

    const results = [];

    for (let i = 0; i < links.length; i++) {
        const result = await testProxy(links[i], i);
        results.push(result);

        console.log(`Result: ${result.status}`);
        if (result.status === 'error') {
            console.log(`Error: ${result.error}`);
        }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `tested_${timestamp}.json`;

    await writeFile(filename, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to ${filename}`);

    const working = results.filter(r => r.status === 'working').length;
    const failed = results.filter(r => r.status === 'error').length;
    const secure = results.filter(r => r.status === 'working' && !r.insecure).length;
    const insecure = results.filter(r => r.status === 'working' && r.insecure).length;

    console.log(`\nSummary:`);
    console.log(`  Total: ${results.length}`);
    console.log(`  Working: ${working} (Secure: ${secure}, Insecure: ${insecure})`);
    console.log(`  Failed: ${failed}`);
}

main().catch(console.error);
