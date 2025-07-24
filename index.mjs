import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { convertLinksToOutbounds } from 'singbox-converter';
import fetch from 'node-fetch';

// --- КОНФИГУРАЦИЯ ---
const LINKS_FILE = 'links.txt';
const SINGBOX_PATH = './sing-box';
const TEMP_CONFIG_PATH = './temp_config.json';
const PROXY_PORT = 2080; // Локальный порт для SOCKS-прокси
const PROXY_HOST = '127.0.0.1';
const TEST_URL = 'https://ip.oxylabs.io/location';
const REQUEST_TIMEOUT = 10000; // 10 секунд таймаут для запросов
const STARTUP_DELAY = 2000; // 2 секунды на запуск sing-box

/**
 * Главная функция скрипта
 */
async function main() {
    console.log('Starting proxy testing process...');
    try {
        const links = await getLinks();
        if (links.length === 0) {
            console.log('No links found in links.txt. Exiting.');
            return;
        }

        console.log(`Found ${links.length} links to test.`);
        const results = [];

        for (const link of links) {
            const result = await testProxy(link);
            results.push(result);
            console.log(`Finished testing: ${result.name} | Status: ${result.status}`);
        }

        const timestamp = new Date().toISOString().replace(/:/g, '-');
        const outputFilename = `tested-${timestamp}.json`;
        await fs.writeFile(outputFilename, JSON.stringify(results, null, 2));
        console.log(`\nAll tests finished. Results saved to ${outputFilename}`);

    } catch (error) {
        console.error('A critical error occurred in main process:', error);
    }
}

/**
 * Читает файл links.txt и возвращает массив ссылок.
 * Поддерживает прямые ссылки и подписки.
 */
async function getLinks() {
    try {
        const fileContent = await fs.readFile(LINKS_FILE, 'utf-8');
        const lines = fileContent.trim().split('\n').filter(line => line.trim() !== '');

        if (lines.length === 1 && (lines[0].startsWith('http://') || lines[0].startsWith('https://'))) {
            console.log(`Detected subscription link: ${lines[0]}`);
            const response = await fetch(lines[0]);
            if (!response.ok) {
                throw new Error(`Failed to fetch subscription, status: ${response.status}`);
            }
            const subscriptionContent = await response.text();
            return subscriptionContent.trim().split('\n').filter(line => line.trim() !== '');
        } else {
            return lines;
        }
    } catch (error) {
        console.error(`Error reading or processing ${LINKS_FILE}:`, error.message);
        return [];
    }
}

/**
 * Тестирует один прокси-сервер.
 * @param {string} link - Ссылка на прокси.
 * @returns {Promise<object>} - Объект с результатами теста.
 */
async function testProxy(link) {
    const name = extractNameFromLink(link);
    console.log(`\n--- Testing: ${name} ---`);

    const baseResult = {
        name: name,
        link: link,
        ip_address: "N/A",
        country_code: "N/A",
        city: "N/A",
        asn_organization: "N/A",
        asn_number: "N/A",
        ping_ms: "N/A",
        download_mbps: "N/A",
        upload_mbps: "N/A",
        status: "error",
        error: "Test did not run",
        timestamp: new Date().toISOString()
    };

    let singboxProcess;
    try {
        const configGenerated = await generateSingboxConfig(link);
        if (!configGenerated) {
            baseResult.error = "Failed to generate sing-box config";
            return baseResult;
        }

        singboxProcess = spawn(SINGBOX_PATH, ['run', '-c', TEMP_CONFIG_PATH]);
        // Раскомментируйте для подробного лога от sing-box
        // singboxProcess.stdout.on('data', (data) => console.log(`sing-box: ${data}`));
        // singboxProcess.stderr.on('data', (data) => console.error(`sing-box-err: ${data}`));

        await new Promise(resolve => setTimeout(resolve, STARTUP_DELAY));

        // Логика проверки в 1-3 запроса
        const testResults = await performConnectionTest();
        baseResult.status = testResults.status;
        baseResult.error = testResults.error;

        if (testResults.status === 'working') {
            baseResult.ping_ms = testResults.ping.toFixed(3);
            Object.assign(baseResult, parseLocationData(testResults.data));
            
            // Запуск speedtest только если прокси рабочий
            const speed = await runSpeedTest();
            baseResult.download_mbps = speed.download;
            baseResult.upload_mbps = speed.upload;
            if (speed.error) {
                // Если speedtest не удался, это не меняет статус "working", но добавляет ошибку
                 baseResult.error = `IP test OK, but speedtest failed: ${speed.error}`;
            }
        }

    } catch (error) {
        console.error(`[${name}] Critical error during test:`, error);
        baseResult.error = error.message || "Unknown critical error";
    } finally {
        if (singboxProcess) {
            singboxProcess.kill();
        }
        try {
            await fs.unlink(TEMP_CONFIG_PATH);
        } catch (e) {
            // Игнорируем ошибку, если файл уже удален
        }
    }
    
    baseResult.timestamp = new Date().toISOString();
    return baseResult;
}

/**
 * Выполняет один запрос для проверки соединения и измеряет пинг.
 * @returns {Promise<{success: boolean, data: object|null, ping: number, error: string|null}>}
 */
async function singleRequest() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    
    const startTime = process.hrtime.bigint();
    try {
        const response = await fetch(TEST_URL, {
            agent: `http://${PROXY_HOST}:${PROXY_PORT}`, // node-fetch > v3 понимает http-агент для https-запросов
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        const endTime = process.hrtime.bigint();
        const ping = Number(endTime - startTime) / 1e6; // в миллисекундах
        
        return { success: true, data, ping, error: null };
    } catch (error) {
        return { success: false, data: null, ping: 0, error: error.name === 'AbortError' ? 'Request timeout' : error.message };
    } finally {
        clearTimeout(timeoutId);
    }
}


/**
 * Реализует логику проверки соединения в 1-3 этапа.
 */
async function performConnectionTest() {
    let attempts = [];
    let lastSuccessfulData = null;
    let lastSuccessfulPing = 0;

    // 1-й запрос
    const res1 = await singleRequest();
    attempts.push(res1.success);
    if (res1.success) {
        lastSuccessfulData = res1.data;
        lastSuccessfulPing = res1.ping;
    }

    // 2-й запрос
    const res2 = await singleRequest();
    attempts.push(res2.success);
    if (res2.success) {
        lastSuccessfulData = res2.data;
        lastSuccessfulPing = res2.ping;
    }
    
    const successes = attempts.filter(Boolean).length;
    const failures = attempts.length - successes;

    // 3-й запрос (если результаты неоднозначны)
    if (successes === 1 && failures === 1) {
        const res3 = await singleRequest();
        attempts.push(res3.success);
        if (res3.success) {
            lastSuccessfulData = res3.data;
            lastSuccessfulPing = res3.ping;
        }
    }

    const finalSuccesses = attempts.filter(Boolean).length;

    if (finalSuccesses >= 2) {
        return { status: 'working', data: lastSuccessfulData, ping: lastSuccessfulPing, error: null };
    } else {
        const lastError = [res1, res2, ...attempts.length > 2 ? [attempts[2]] : []]
            .reverse()
            .find(r => r && r.error)?.error || "Multiple connection attempts failed";
        return { status: 'error', data: null, ping: 0, error: `IP test failed: ${lastError}` };
    }
}


/**
 * Запускает speedtest-cli через прокси.
 * @returns {Promise<{download: string, upload: string, error: string|null}>}
 */
function runSpeedTest() {
    return new Promise(resolve => {
        const command = `HTTPS_PROXY=socks5h://${PROXY_HOST}:${PROXY_PORT} speedtest-cli --json --timeout 15`;
        
        let stdout = '';
        let stderr = '';
        const proc = spawn('sh', ['-c', command]);

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (code === 0 && stdout) {
                try {
                    const result = JSON.parse(stdout);
                    resolve({
                        download: (result.download / 1e6).toFixed(2), // в Mbps
                        upload: (result.upload / 1e6).toFixed(2),   // в Mbps
                        error: null
                    });
                } catch (e) {
                    resolve({ download: "N/A", upload: "N/A", error: "Failed to parse speedtest JSON" });
                }
            } else {
                resolve({ download: "N/A", upload: "N/A", error: stderr || `Process exited with code ${code}` });
            }
        });
    });
}

/**
 * Генерирует временный конфиг для sing-box.
 * @param {string} link - Ссылка на прокси.
 */
async function generateSingboxConfig(link) {
    try {
        const outbounds = await convertLinksToOutbounds(link);
        if (!outbounds || outbounds.length === 0) {
            throw new Error('singbox-converter did not return any outbound.');
        }

        const config = {
            log: {
                level: "warn",
                timestamp: true,
            },
            inbounds: [
                {
                    type: "socks",
                    tag: "socks-in",
                    listen: PROXY_HOST,
                    listen_port: PROXY_PORT,
                },
            ],
            outbounds: outbounds,
            route: {
                rules: [
                    {
                        protocol: "dns",
                        outbound: "dns-out",
                    },
                    {
                        outbound: outbounds[0].tag,
                    },
                ],
            },
        };
        await fs.writeFile(TEMP_CONFIG_PATH, JSON.stringify(config, null, 2));
        return true;
    } catch (error) {
        console.error('Error generating sing-box config:', error.message);
        return false;
    }
}

/**
 * Извлекает имя из фрагмента URL (#).
 * @param {string} link
 */
function extractNameFromLink(link) {
    try {
        const url = new URL(link);
        return url.hash ? decodeURIComponent(url.hash.substring(1)) : 'Unnamed';
    } catch (e) {
        const match = link.match(/#(.+)/);
        return match ? decodeURIComponent(match[1]) : 'Invalid Link';
    }
}

/**
 * Разбирает данные о местоположении из ответа oxylabs.
 * @param {object} data - JSON-объект ответа.
 */
function parseLocationData(data) {
    if (!data || !data.ip) return {};
    const providerData = data.providers?.ipinfo || data.providers?.dbip || {};
    return {
        ip_address: data.ip || "N/A",
        country_code: providerData.country || "N/A",
        city: providerData.city || "N/A",
        asn_organization: providerData.org_name || "N/A",
        asn_number: providerData.asn ? providerData.asn.replace('AS', '') : "N/A",
    };
}


// Запуск главной функции
main();
