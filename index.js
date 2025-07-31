import { readFile, writeFile, access } from 'fs/promises';
import { spawn } from 'child_process';
import { convertToOutbounds } from 'singbox-converter';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);
const TEST_URL = 'https://ip.oxylabs.io/location';
const PROXY_PORT = 10808;
const PROXY_ADDRESS = `socks5h://127.0.0.1:${PROXY_PORT}`;
const STARTUP_DELAY = 3000;
const REQUEST_TIMEOUT = 15;

// Read links from file
async function readLinks() {
    try {
        const content = await readFile('links.txt', 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());
        
        // Check if it's a single subscription URL
        if (lines.length === 1 && (lines[0].startsWith('http://') || lines[0].startsWith('https://'))) {
            console.log('Detected subscription URL, fetching...');
            const response = await fetch(lines[0]);
            const subContent = await response.text();
            
            // Check if content is base64 encoded
            try {
                const decoded = Buffer.from(subContent, 'base64').toString('utf-8');
                if (decoded.includes('://')) {
                    return decoded.trim().split('\n').filter(line => line.trim());
                }
            } catch (e) {
                // Not base64, use as is
            }
            
            return subContent.trim().split('\n').filter(line => line.trim());
        }
        
        return lines;
    } catch (error) {
        console.error('Error reading links:', error);
        return [];
    }
}

// Create sing-box config
function createSingboxConfig(outbound) {
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

// Run sing-box
function startSingbox(configPath) {
    return new Promise((resolve, reject) => {
        const singbox = spawn('sing-box', ['run', '-c', configPath], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let startupTimeout = setTimeout(() => {
            reject(new Error('Sing-box startup timeout'));
        }, 10000);

        singbox.stdout.on('data', (data) => {
            const output = data.toString();
            if (output.includes('sing-box started') || output.includes('tcp server started')) {
                clearTimeout(startupTimeout);
                setTimeout(() => resolve(singbox), STARTUP_DELAY);
            }
        });

        singbox.stderr.on('data', (data) => {
            const error = data.toString();
            if (error.includes('ERROR')) {
                clearTimeout(startupTimeout);
                reject(new Error(`Sing-box error: ${error}`));
            }
        });

        singbox.on('error', (err) => {
            clearTimeout(startupTimeout);
            reject(err);
        });
    });
}

// Make HTTP request through proxy
async function makeProxyRequest(warmup = false) {
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

        return {
            success: true,
            data: JSON.parse(responseBody),
            latency: parseFloat(latencyS) * 1000 // Convert to ms
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// Run speedtest
async function runSpeedtest() {
    try {
        const { stdout } = await exec(`ALL_PROXY="${PROXY_ADDRESS}" speedtest-cli --simple --timeout 45`);
        
        const ping = stdout.match(/Ping: ([\d.]+) ms/)?.[1] || 'N/A';
        const download = stdout.match(/Download: ([\d.]+) Mbit\/s/)?.[1] || 'N/A';
        const upload = stdout.match(/Upload: ([\d.]+) Mbit\/s/)?.[1] || 'N/A';
        
        return {
            ping_ms: ping,
            download_mbps: download,
            upload_mbps: upload
        };
    } catch (error) {
        console.error('Speedtest failed:', error.message);
        return {
            ping_ms: 'N/A',
            download_mbps: 'N/A',
            upload_mbps: 'N/A'
        };
    }
}

// Test single proxy
async function testProxy(link, index) {
    console.log(`\nTesting proxy ${index + 1}: ${link.substring(0, 50)}...`);
    
    let outbound;
    try {
        const outbounds = await convertToOutbounds(link);
        if (!outbounds || outbounds.length === 0) {
            throw new Error('Failed to convert link to outbound');
        }
        outbound = outbounds[0];
    } catch (error) {
        console.error('Conversion error:', error.message);
        return createErrorResult(link, 'Conversion failed: ' + error.message);
    }

    const configFile = `temp_config_${index}.json`;
    const config = createSingboxConfig(outbound);
    
    try {
        await writeFile(configFile, JSON.stringify(config, null, 2));
    } catch (error) {
        return createErrorResult(link, 'Failed to write config: ' + error.message, outbound.tag);
    }

    let singboxProcess;
    try {
        singboxProcess = await startSingbox(configFile);
    } catch (error) {
        await exec(`rm -f ${configFile}`);
        return createErrorResult(link, 'Sing-box startup failed: ' + error.message, outbound.tag);
    }

    try {
        // Warmup request
        console.log('Making warmup request...');
        await makeProxyRequest(true);
        
        // Test logic: make 2 requests, if mixed results, make 3rd
        console.log('Making test requests...');
        const request1 = await makeProxyRequest();
        const request2 = await makeProxyRequest();
        
        let finalResult;
        let successCount = [request1, request2].filter(r => r.success).length;
        
        if (successCount === 1) {
            // Mixed results, need 3rd request
            console.log('Mixed results, making 3rd request...');
            const request3 = await makeProxyRequest();
            successCount = [request1, request2, request3].filter(r => r.success).length;
            finalResult = [request1, request2, request3].find(r => r.success) || request3;
        } else {
            finalResult = request2.success ? request2 : request1;
        }
        
        const isWorking = successCount >= 2;
        
        if (isWorking) {
            console.log('Proxy is working, running speedtest...');
            const speedtest = await runSpeedtest();
            
            const ipData = finalResult.data || {};
            const providers = ipData.providers || {};
            
            // Extract data with fallbacks
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
                name: outbound.tag || 'Unknown',
                full_link: link,
                ip_address: ipData.ip || 'N/A',
                country_code: country,
                city: city,
                asn_organization: asn_org,
                asn_number: asn_number,
                ping_ms: finalResult.latency?.toFixed(0) || speedtest.ping_ms,
                download_mbps: speedtest.download_mbps,
                upload_mbps: speedtest.upload_mbps,
                speedtest_result: speedtest,
                ip_info_response: ipData,
                timestamp: new Date().toISOString()
            };
        } else {
            const error = finalResult.error || 'Connection failed';
            return createErrorResult(link, error, outbound.tag);
        }
    } finally {
        // Cleanup
        if (singboxProcess) {
            singboxProcess.kill('SIGTERM');
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                singboxProcess.kill('SIGKILL');
            } catch (e) {}
        }
        await exec(`rm -f ${configFile}`);
    }
}

// Create error result
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
        download_mbps: 'N/A',
        upload_mbps: 'N/A',
        error: error,
        timestamp: new Date().toISOString()
    };
}

// Main function
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
    
    // Save results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `tested_${timestamp}.json`;
    
    await writeFile(filename, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to ${filename}`);
    
    // Summary
    const working = results.filter(r => r.status === 'working').length;
    const failed = results.filter(r => r.status === 'error').length;
    console.log(`\nSummary: ${working} working, ${failed} failed`);
}

// Run
main().catch(console.error);
