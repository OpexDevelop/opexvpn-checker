import { readFile, writeFile } from 'fs/promises';
import { spawn } from 'child_process';
import { convertToOutbounds } from 'singbox-converter';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';
import fetch from 'node-fetch';
import https from 'https';

const exec = promisify(execCallback);

const TEST_URL = 'https://ip.oxylabs.io/location';
const STARTUP_DELAY = 5000;
const REQUEST_TIMEOUT = 15;
const CONCURRENCY_LIMIT = 10;
const BASE_PORT = 20000;
const DB_FILE = './db.json';

// Создаем агент для игнорирования SSL ошибок
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

async function loadDatabase() {
    try {
        const data = await readFile(DB_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function saveDatabase(data) {
    await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

async function fetchSubscription(url) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 7000);
        
        const response = await fetch(url, {
            agent: url.startsWith('https') ? httpsAgent : undefined,
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        const content = await response.text();
        
        // Пробуем декодировать как base64
        try {
            const decoded = Buffer.from(content, 'base64').toString('utf-8');
            if (decoded.includes('://')) {
                return decoded.trim().split('\n').filter(line => line.trim());
            }
        } catch (e) {
            // Not base64
        }
        
        // Если не base64, проверяем plain text
        if (content.includes('://')) {
            return content.trim().split('\n').filter(line => line.trim());
        }
        
        throw new Error('Not a valid subscription');
    } catch (error) {
        throw error;
    }
}

async function readLinks() {
    try {
        const content = await readFile('links.txt', 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());
        const allLinks = [];
        
        for (const line of lines) {
            if (line.includes('://')) {
                if (line.startsWith('http://') || line.startsWith('https://')) {
                    // Пытаемся загрузить как подписку
                    try {
                        const subLinks = await fetchSubscription(line);
                        allLinks.push(...subLinks);
                    } catch (error) {
                        // Если не подписка, добавляем как обычную ссылку
                        allLinks.push(line);
                    }
                } else {
                    // Обычная прокси ссылка
                    allLinks.push(line);
                }
            }
        }
        
        return allLinks;
    } catch (error) {
        console.error('Error reading links:', error);
        return [];
    }
}

function extractLinkWithoutFragment(fullLink) {
    return fullLink.split('#')[0];
}

function getMostCommonValue(values) {
    if (!values || values.length === 0) return '';
    
    const counts = {};
    values.forEach(val => {
        if (val && val !== '') {
            counts[val] = (counts[val] || 0) + 1;
        }
    });
    
    let maxCount = 0;
    let mostCommon = '';
    
    for (const [value, count] of Object.entries(counts)) {
        if (count > maxCount) {
            maxCount = count;
            mostCommon = value;
        }
    }
    
    return mostCommon;
}

function extractGeoData(ipInfoResponse) {
    const providers = ipInfoResponse.providers || {};
    const providerPriority = ['maxmind', 'ipinfo', 'ip2location', 'dbip'];
    
    // Собираем все значения по каждому полю
    const countries = [];
    const cities = [];
    const asns = [];
    const orgNames = [];
    
    for (const provider of Object.keys(providers)) {
        const data = providers[provider];
        if (data.country) countries.push(data.country);
        if (data.city) cities.push(data.city);
        if (data.asn) asns.push(data.asn);
        if (data.org_name) orgNames.push(data.org_name);
    }
    
    // Выбираем наиболее частые значения
    let country = getMostCommonValue(countries);
    let city = getMostCommonValue(cities);
    let asn = getMostCommonValue(asns);
    let orgName = getMostCommonValue(orgNames);
    
    // Если нет консенсуса, используем приоритет провайдеров
    if (!country) {
        for (const provider of providerPriority) {
            if (providers[provider]?.country) {
                country = providers[provider].country;
                break;
            }
        }
    }
    
    if (!city) {
        for (const provider of providerPriority) {
            if (providers[provider]?.city) {
                city = providers[provider].city;
                break;
            }
        }
    }
    
    if (!asn) {
        for (const provider of providerPriority) {
            if (providers[provider]?.asn) {
                asn = providers[provider].asn;
                break;
            }
        }
    }
    
    if (!orgName) {
        for (const provider of providerPriority) {
            if (providers[provider]?.org_name) {
                orgName = providers[provider].org_name;
                break;
            }
        }
    }
    
    return {
        country: country || '',
        city: city || '',
        asn: asn || '',
        org_name: orgName || ''
    };
}

function shouldCheckProxy(proxy) {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const oneWeek = 7 * oneDay;
    const oneMonth = 30 * oneDay;
    
    if (!proxy.checks || proxy.checks.length === 0) {
        return true;
    }
    
    const lastCheck = proxy.checks[proxy.checks.length - 1];
    const lastCheckTime = new Date(lastCheck.timestamp).getTime();
    const timeSinceLastCheck = now - lastCheckTime;
    
    // Считаем последовательные ошибки
    let consecutiveErrors = 0;
    for (let i = proxy.checks.length - 1; i >= 0; i--) {
        if (proxy.checks[i].error) {
            consecutiveErrors++;
        } else {
            break;
        }
    }
    
    // Определяем частоту проверок
    if (consecutiveErrors === 0) {
        return timeSinceLastCheck >= oneDay;
    } else if (consecutiveErrors < 7) {
        return timeSinceLastCheck >= oneDay;
    } else if (consecutiveErrors < 30) {
        return timeSinceLastCheck >= oneWeek;
    } else {
        return timeSinceLastCheck >= oneMonth;
    }
}

function createSingboxConfig(outbound, port, allowInsecure = false) {
    if (allowInsecure && outbound.tls && outbound.tls.enabled) {
        outbound.tls.insecure = true;
    }

    return {
        log: {
            level: "error",
            timestamp: true
        },
        inbounds: [{
            type: "socks",
            tag: "socks-in",
            listen: "127.0.0.1",
            listen_port: port,
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

async function makeProxyRequest(port) {
    try {
        const proxyAddress = `socks5h://127.0.0.1:${port}`;
        const curlCommand = `curl -s --proxy "${proxyAddress}" --max-time ${REQUEST_TIMEOUT} -w "\\n---STATS---\\nHTTP_CODE:%{http_code}\\nLATENCY_S:%{time_starttransfer}" "${TEST_URL}"`;

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

async function testProxyWithSettings(link, index, outbound, port, allowInsecure) {
    const configFile = `temp_config_${index}_${port}.json`;
    const config = createSingboxConfig(outbound, port, allowInsecure);

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
        await makeProxyRequest(port);

        const request1 = await makeProxyRequest(port);
        const request2 = await makeProxyRequest(port);

        let finalResult;
        let successCount = [request1, request2].filter(r => r.success).length;

        if (successCount === 1) {
            const request3 = await makeProxyRequest(port);
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

async function testProxy(link, index, port) {
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
        return {
            success: false,
            error: 'Conversion failed: ' + error.message,
            name: name
        };
    }

    let testResult = await testProxyWithSettings(link, index, outbound, port, false);

    if (!testResult.success && outbound.tls && outbound.tls.enabled) {
        testResult = await testProxyWithSettings(link, index, outbound, port, true);
    }

    return {
        ...testResult,
        name: name
    };
}

function extractNameFromLink(link) {
    const match = link.match(/#(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

async function main() {
    console.log('Starting proxy tests...');

    const links = await readLinks();
    if (links.length === 0) {
        console.error('No links found in links.txt');
        return;
    }

    const database = await loadDatabase();
    const now = new Date().toISOString();

    console.log(`Found ${links.length} links to test`);

    // Создаем или обновляем записи для каждой ссылки
    for (const fullLink of links) {
        const link = extractLinkWithoutFragment(fullLink);
        let proxyEntry = database.find(p => p.link === link);

        if (!proxyEntry) {
            proxyEntry = {
                status: 'pending',
                name: extractNameFromLink(fullLink) || 'Unknown',
                link: link,
                full_link: fullLink,
                created_at: now,
                checks: []
            };
            database.push(proxyEntry);
        } else {
            // Обновляем full_link и name если изменились
            proxyEntry.full_link = fullLink;
            const newName = extractNameFromLink(fullLink);
            if (newName) {
                proxyEntry.name = newName;
            }
        }
    }

    // Фильтруем прокси для проверки
    const proxiesToCheck = database.filter(shouldCheckProxy);
    console.log(`${proxiesToCheck.length} proxies need checking`);

    // Тестируем прокси
    for (let i = 0; i < proxiesToCheck.length; i += CONCURRENCY_LIMIT) {
        const chunk = proxiesToCheck.slice(i, i + CONCURRENCY_LIMIT);
        console.log(`\nProcessing chunk ${i / CONCURRENCY_LIMIT + 1} of ${Math.ceil(proxiesToCheck.length / CONCURRENCY_LIMIT)}...`);

        const promises = chunk.map(async (proxyEntry, chunkIndex) => {
            const globalIndex = i + chunkIndex;
            const port = BASE_PORT + globalIndex;
            const result = await testProxy(proxyEntry.full_link, globalIndex, port);

            const checkResult = {
                timestamp: new Date().toISOString()
            };

            if (result.success) {
                const ipData = result.result.data || {};
                const geoData = extractGeoData(ipData);

                checkResult.ip_address = ipData.ip || 'N/A';
                checkResult.ping_ms = result.result.latency?.toFixed(0) || 'N/A';
                checkResult.insecure = result.insecure;
                checkResult.country = geoData.country;
                checkResult.asn = geoData.asn;
                checkResult.org_name = geoData.org_name;
                checkResult.city = geoData.city;

                // Добавляем ip_info_response только если изменился
                const lastCheck = proxyEntry.checks[proxyEntry.checks.length - 1];
                if (!lastCheck || JSON.stringify(lastCheck.ip_info_response) !== JSON.stringify(ipData)) {
                    checkResult.ip_info_response = ipData;
                }

                proxyEntry.status = 'working';
            } else {
                checkResult.error = result.error;
                proxyEntry.status = 'error';
            }

            proxyEntry.checks.push(checkResult);

            console.log(`- ${proxyEntry.name.substring(0, 30)}...: ${result.success ? 'WORKING' : 'ERROR'}`);
        });

        await Promise.allSettled(promises);
    }

    // Сохраняем базу данных
    await saveDatabase(database);
    console.log(`\nDatabase updated in ${DB_FILE}`);

    // Статистика
    const working = database.filter(p => p.status === 'working').length;
    const errors = database.filter(p => p.status === 'error').length;
    const pending = database.filter(p => p.status === 'pending').length;

    console.log('\nSummary:');
    console.log(`  Total: ${database.length}`);
    console.log(`  Working: ${working}`);
    console.log(`  Errors: ${errors}`);
    console.log(`  Pending: ${pending}`);
}

main().catch(console.error);
