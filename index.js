import { readFile, writeFile, access } from 'fs/promises';
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
const ALLOW_INSECURE = true; // Like in old code

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

// Apply insecure to all TLS configs if needed
function applyInsecureIfNeeded(outbound) {
    if (ALLOW_INSECURE && outbound.tls && outbound.tls.enabled) {
        outbound.tls.insecure = true;
    }
    return outbound;
}

// Create sing-box config
function createSingboxConfig(outbound) {
    // Apply insecure setting
    outbound = applyInsecureIfNeeded(outbound);
    
    return {
        log: {
            level: "debug",
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
        console.log(`Starting sing-box with config: ${configPath}`);
        
        const singbox = spawn('sing-box', ['run', '-c', configPath], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let startupTimeout = setTimeout(() => {
            console.log('Sing-box startup timeout reached');
            singbox.kill('SIGKILL');
            reject(new Error('Sing-box startup timeout'));
        }, 20000); // Increased timeout

        let outputBuffer = '';
        let errorBuffer = '';

        const checkStarted = (data) => {
            const output = data.toString();
            outputBuffer += output;
            
            // Check various startup indicators
            if (output.includes('started') || 
                output.includes('server started') ||
                output.includes('tcp server started') ||
                output.includes('listening') ||
                outputBuffer.includes('inbound/socks')) {
                console.log('Sing-box started successfully');
                clearTimeout(startupTimeout);
                setTimeout(() => resolve(singbox), STARTUP_DELAY);
            }
        };

        singbox.stdout.on('data', checkStarted);
        singbox.stderr.on('data', (data) => {
            const error = data.toString();
            errorBuffer += error;
            
            // Also check stderr for startup messages
            checkStarted(data);
            
            // Check for fatal errors
            if (error.includes('FATAL') || error.includes('panic')) {
                console.error('Sing-box fatal error:', error);
                clearTimeout(startupTimeout);
                singbox.kill('SIGKILL');
                reject(new Error(`Sing-box error: ${error}`));
            }
        });

        singbox.on('error', (err) => {
            console.error('Sing-box spawn error:', err);
            clearTimeout(startupTimeout);
            reject(err);
        });

        singbox.on('exit', (code, signal) => {
            clearTimeout(startupTimeout);
            if (code !== 0 && code !== null) {
                console.error(`Sing-box exited with code ${code}`);
                console.error('Stdout:', outputBuffer);
                console.error('Stderr:', errorBuffer);
                reject(new Error(`Sing-box exited with code ${code}`));
            }
        });

        // Additional check after a short delay
        setTimeout(() => {
            try {
                // Check if process is still running
                process.kill(singbox.pid, 0);
                // If we're here, process is running, assume it started
                if (startupTimeout) {
                    console.log('Sing-box appears to be running, assuming started');
                    clearTimeout(startupTimeout);
                    setTimeout(() => resolve(singbox), STARTUP_DELAY);
                }
            } catch (e) {
                // Process is not running
            }
        }, 3000);
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

        let data;
        try {
            data = JSON.parse(responseBody);
        } catch (e) {
            throw new Error('Invalid JSON response');
        }

        return {
            success: true,
            data: data,
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
        console.log('Running speedtest...');
        const { stdout, stderr } = await exec(`ALL_PROXY="${PROXY_ADDRESS}" speedtest-cli --simple --timeout 45`);
        
        if (stderr) {
            console.error('Speedtest stderr:', stderr);
        }
        
        const ping = stdout.match(/Ping: ([\d.]+) ms/)?.[1] || 'N/A';
        const download = stdout.match(/Download: ([\d.]+) Mbit\/s/)?.[1] || 'N/A';
        const upload = stdout.match(/Upload: ([\d.]+) Mbit\/s/)?.[1] || 'N/A';
        
        console.log(`Speedtest results: Ping=${ping}ms, Down=${download}Mbps, Up=${upload}Mbps`);
        
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

    const configFile = `temp_config_${index}.json`;
    const config = createSingboxConfig(outbound);
    
    try {
        await writeFile(configFile, JSON.stringify(config, null, 2));
    } catch (error) {
        return createErrorResult(link, 'Failed to write config: ' + error.message, name);
    }

    let singboxProcess;
    try {
        singboxProcess = await startSingbox(configFile);
    } catch (error) {
        await exec(`rm -f ${configFile}`).catch(() => {});
        return createErrorResult(link, 'Sing-box startup failed: ' + error.message, name);
    }

    try {
        // Warmup request
        console.log('Making warmup request...');
        const warmupResult = await makeProxyRequest(true);
        console.log(`Warmup result: ${warmupResult.success ? 'success' : 'failed'}`);
        
        // Test logic: make 2 requests, if mixed results, make 3rd
        console.log('Making test requests...');
        const request1 = await makeProxyRequest();
        console.log(`Request 1: ${request1.success ? 'success' : 'failed'}`);
        
        const request2 = await makeProxyRequest();
        console.log(`Request 2: ${request2.success ? 'success' : 'failed'}`);
        
        let finalResult;
        let successCount = [request1, request2].filter(r => r.success).length;
        
        if (successCount === 1) {
            // Mixed results, need 3rd request
            console.log('Mixed results, making 3rd request...');
            const request3 = await makeProxyRequest();
            console.log(`Request 3: ${request3.success ? 'success' : 'failed'}`);
            
            successCount = [request1, request2, request3].filter(r => r.success).length;
            finalResult = [request1, request2, request3].find(r => r.success) || request3;
        } else {
            finalResult = request2.success ? request2 : request1;
        }
        
        const isWorking = successCount >= 2;
        console.log(`Proxy status: ${isWorking ? 'WORKING' : 'NOT WORKING'}`);
        
        if (isWorking) {
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
                name: name,
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
            return createErrorResult(link, error, name);
        }
    } finally {
        // Cleanup
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
            } catch (e) {
                console.error('Error killing sing-box:', e.message);
            }
        }
        await exec(`rm -f ${configFile}`).catch(() => {});
    }
}

// Extract name from link
function extractNameFromLink(link) {
    const match = link.match(/#(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
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
    console.log(`ALLOW_INSECURE mode: ${ALLOW_INSECURE}`);
    
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
