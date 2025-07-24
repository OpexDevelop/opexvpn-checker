import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { convertLinksToOutbounds } from 'singbox-converter';
import speedtest from 'speedtest-net';

// --- CONFIGURATION ---
const LINKS_FILE_PATH = './links.txt';
const TEST_URL = 'https://ip.oxylabs.io/location';
const SINGBOX_EXEC_PATH = './sing-box'; // Path to the sing-box executable
const SINGBOX_CONFIG_DIR = './temp_configs';
const SINGBOX_BASE_PORT = 20000; // Base port to avoid conflicts
const REQUEST_TIMEOUT = 15000; // 15 seconds for IP/location requests
const SPEEDTEST_TIMEOUT = 120000; // 2 minutes for speedtest

// --- MAIN EXECUTION ---
async function main() {
    console.log('Starting proxy test process...');
    try {
        await fs.mkdir(SINGBOX_CONFIG_DIR, { recursive: true });

        const links = await getLinks();
        if (!links || links.length === 0) {
            console.log('No links found to test.');
            return;
        }

        console.log(`Found ${links.length} links. Starting tests...`);

        const results = [];
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            const workerId = i; // Unique ID for this worker/proxy
            console.log(`\n[${i + 1}/${links.length}] Testing: ${getProxyName(link)}`);
            const result = await testProxy(link, workerId);
            results.push(result);
        }
        
        const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
        const outputFilename = `tested-${timestamp}.json`;
        await fs.writeFile(outputFilename, JSON.stringify(results, null, 2));

        console.log(`\nAll tests finished. Results saved to ${outputFilename}`);

    } catch (error) {
        console.error('An unexpected error occurred in the main process:', error);
    } finally {
        // Cleanup temporary config directory
        await fs.rm(SINGBOX_CONFIG_DIR, { recursive: true, force: true });
        console.log('Cleanup complete.');
    }
}

/**
 * Reads links from the local links.txt file or fetches them from a URL.
 * @returns {Promise<string[]>} An array of proxy links.
 */
async function getLinks() {
    try {
        const content = await fs.readFile(LINKS_FILE_PATH, 'utf-8');
        const lines = content.trim().split('\n').map(line => line.trim()).filter(Boolean);

        if (lines.length === 1 && (lines[0].startsWith('http://') || lines[0].startsWith('https://'))) {
            console.log(`Detected subscription link: ${lines[0]}`);
            const response = await fetch(lines[0]);
            if (!response.ok) {
                throw new Error(`Failed to fetch subscription: ${response.statusText}`);
            }
            const subContent = await response.text();
            return subContent.trim().split('\n').map(line => line.trim()).filter(Boolean);
        } else {
            console.log('Reading links from local links.txt file.');
            return lines;
        }
    } catch (error) {
        console.error('Error reading or fetching links:', error.message);
        return [];
    }
}

/**
 * Extracts the name from a proxy link (text after #).
 * @param {string} link The full proxy link.
 * @returns {string} The name of the proxy.
 */
function getProxyName(link) {
    try {
        const url = new URL(link);
        return decodeURIComponent(url.hash.substring(1)) || 'N/A';
    } catch (e) {
        // Handle cases where the link is not a valid URL format but might still be parseable by sing-box
        const nameMatch = link.match(/#(.+)/);
        return nameMatch ? decodeURIComponent(nameMatch[1]) : 'N/A';
    }
}

/**
 * Creates a complete sing-box configuration for a given proxy link.
 * @param {string} link The proxy link.
 * @param {number} port The local SOCKS port to use.
 * @returns {Promise<object|null>} A sing-box config object or null on failure.
 */
async function createSingboxConfig(link, port) {
    try {
        const outbounds = await convertLinksToOutbounds(link);
        if (!outbounds || outbounds.length === 0) {
            throw new Error('Could not convert link to a sing-box outbound.');
        }

        return {
            "log": { "level": "warn" },
            "inbounds": [
                {
                    "type": "socks",
                    "tag": "socks-in",
                    "listen": "127.0.0.1",
                    "listen_port": port
                }
            ],
            "outbounds": [
                ...outbounds,
                { "type": "direct", "tag": "direct" },
                { "type": "block", "tag": "block" }
            ]
        };
    } catch (error) {
        console.error('Error creating sing-box config:', error.message);
        return null;
    }
}

/**
 * Performs a single request through the proxy to the test URL.
 * @param {number} port The local SOCKS port.
 * @returns {Promise<object>} An object with test results.
 */
async function performIpTest(port) {
    const agent = new SocksProxyAgent(`socks5://127.0.0.1:${port}`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const startTime = performance.now();
    try {
        const response = await fetch(TEST_URL, { agent, signal: controller.signal });
        const firstByteTime = performance.now();

        if (!response.ok) {
            throw new Error(`Request failed with status: ${response.status}`);
        }

        const data = await response.json();
        const endTime = performance.now();
        
        clearTimeout(timeoutId);

        return {
            success: true,
            data: data,
            ping: Math.round(firstByteTime - startTime),
            error: null
        };
    } catch (error) {
        clearTimeout(timeoutId);
        const endTime = performance.now();
        return {
            success: false,
            data: null,
            ping: Math.round(endTime - startTime),
            error: error.name === 'AbortError' ? 'Request timed out' : error.message
        };
    }
}

/**
 * Runs a speed test through the specified proxy.
 * @param {number} port The local SOCKS port.
 * @returns {Promise<object>} An object with speed test results.
 */
async function performSpeedTest(port) {
    console.log('  Running speed test...');
    try {
        const result = await speedtest({
            acceptLicense: true,
            acceptGdpr: true,
            proxy: `socks5://127.0.0.1:${port}`,
            timeout: SPEEDTEST_TIMEOUT
        });
        console.log('  Speed test completed.');
        return {
            download_mbps: (result.download.bandwidth / 125000).toFixed(2), // Bps to Mbps
            upload_mbps: (result.upload.bandwidth / 125000).toFixed(2), // Bps to Mbps
            error: null
        };
    } catch (err) {
        console.error('  Speed test failed:', err.message);
        return {
            download_mbps: '0.00',
            upload_mbps: '0.00',
            error: `Speed test failed: ${err.message}`
        };
    }
}


/**
 * Tests a single proxy link comprehensively.
 * @param {string} link The proxy link to test.
 * @param {number} workerId A unique ID for this test run.
 * @returns {Promise<object>} The final JSON result for this proxy.
 */
async function testProxy(link, workerId) {
    const port = SINGBOX_BASE_PORT + workerId;
    const configPath = path.join(SINGBOX_CONFIG_DIR, `config-${workerId}.json`);
    const proxyName = getProxyName(link);
    
    const baseResult = {
        name: proxyName,
        link: link,
        status: 'error',
        ip_address: 'N/A',
        country_code: 'N/A',
        city: 'N/A',
        asn_organization: 'N/A',
        asn_number: 'N/A',
        ping_ms: 'N/A',
        download_mbps: '0.00',
        upload_mbps: '0.00',
        error: 'Unknown failure',
        timestamp: new Date().toISOString()
    };

    const config = await createSingboxConfig(link, port);
    if (!config) {
        baseResult.error = 'Failed to create sing-box config from link.';
        return baseResult;
    }
    
    await fs.writeFile(configPath, JSON.stringify(config));

    const singboxProcess = spawn(SINGBOX_EXEC_PATH, ['run', '-c', configPath]);
    
    singboxProcess.stderr.on('data', (data) => {
        // console.error(`[sing-box-err-${workerId}]: ${data}`);
    });

    // Wait for sing-box to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    let finalResult = { ...baseResult };
    let finalIpData = null;
    let finalPing = 'N/A';
    let isWorking = false;

    try {
        // --- Complex Test Logic ---
        console.log('  Performing 1st IP test (warm-up)...');
        const test1 = await performIpTest(port);
        console.log(`  Test 1: ${test1.success ? 'Success' : 'Fail'} (${test1.error || `${test1.ping}ms`})`);

        console.log('  Performing 2nd IP test...');
        const test2 = await performIpTest(port);
        console.log(`  Test 2: ${test2.success ? 'Success' : 'Fail'} (${test2.error || `${test2.ping}ms`})`);

        if (test1.success && test2.success) {
            isWorking = true;
            finalIpData = test2.data;
            finalPing = test2.ping;
        } else if (!test1.success && !test2.success) {
            isWorking = false;
            finalResult.error = `Both initial IP tests failed. Last error: ${test2.error}`;
        } else {
            // One success, one failure. Need a tie-breaker.
            console.log('  Indeterminate result. Performing 3rd (tie-breaker) IP test...');
            const test3 = await performIpTest(port);
            console.log(`  Test 3: ${test3.success ? 'Success' : 'Fail'} (${test3.error || `${test3.ping}ms`})`);

            const successes = [test1, test2, test3].filter(t => t.success).length;
            if (successes >= 2) {
                isWorking = true;
                const lastSuccess = [test3, test2, test1].find(t => t.success);
                finalIpData = lastSuccess.data;
                finalPing = lastSuccess.ping;
            } else {
                isWorking = false;
                const lastError = [test3, test2, test1].find(t => !t.success);
                finalResult.error = `Not enough successful tests (only ${successes}/3). Last error: ${lastError.error}`;
            }
        }

        // --- Process Results ---
        if (isWorking) {
            console.log('  Proxy is WORKING.');
            finalResult.status = 'working';
            finalResult.ping_ms = finalPing.toString();
            
            // Populate location data from the final successful test
            if (finalIpData) {
                finalResult.ip_address = finalIpData.ip || 'N/A';
                // Find the best provider for location data
                const provider = finalIpData.providers?.ipinfo || finalIpData.providers?.dbip || finalIpData.providers?.ip2location || {};
                finalResult.country_code = provider.country || 'N/A';
                finalResult.city = provider.city || 'N/A';
                finalResult.asn_organization = provider.org_name || 'N/A';
                finalResult.asn_number = provider.asn ? provider.asn.replace('AS', '') : 'N/A';
            }

            const speedData = await performSpeedTest(port);
            finalResult.download_mbps = speedData.download_mbps;
            finalResult.upload_mbps = speedData.upload_mbps;
            if (speedData.error) {
                // Append speedtest error if it happened, but don't mark as failed
                finalResult.error = speedData.error;
            } else {
                finalResult.error = null; // Clear previous error messages if everything succeeded
            }
        } else {
             console.log('  Proxy is NOT WORKING.');
            // Error message is already set by the test logic
        }

    } catch (e) {
        console.error('  An error occurred during the test cycle:', e);
        finalResult.error = e.message;
    } finally {
        // --- Cleanup ---
        singboxProcess.kill('SIGKILL');
        // The config file is deleted in the main finally block
    }

    return finalResult;
}

// --- Start the script ---
main();

