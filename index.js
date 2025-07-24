import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import { convertLinksToOutbounds } from 'singbox-converter';
import speedtest from 'speedtest-net';
import { HttpsProxyAgent } from 'https-proxy-agent';

// --- КОНСТАНТЫ И НАСТРОЙКИ ---
const LINKS_FILE = 'links.txt';
const TEST_URL = 'https://ip.oxylabs.io/location';
const PROXY_PORT = 2080; // Локальный порт для входящих подключений sing-box
const PROXY_ADDRESS = `http://127.0.0.1:${PROXY_PORT}`;
const REQUEST_TIMEOUT = 15000; // 15 секунд
const SINGBOX_CONFIG_FILE = 'config.json';

/**
 * Главная функция, запускающая весь процесс
 */
async function main() {
    console.log('Starting proxy test process...');
    let links;
    try {
        links = await getLinksFromFile(LINKS_FILE);
    } catch (error) {
        console.error(`Error reading links file: ${error.message}`);
        process.exit(1);
    }

    if (links.length === 0) {
        console.log('No links found to test.');
        return;
    }

    console.log(`Found ${links.length} links to test.`);
    const results = [];

    for (const link of links) {
        const result = await testProxy(link);
        results.push(result);
        console.log(`Result for ${result.name}: ${result.status}`);
    }

    await saveResultsToJson(results);
    console.log('All tests finished. Results saved.');
}

/**
 * Читает файл links.txt и возвращает массив ссылок.
 * Поддерживает прямые ссылки и подписки.
 * @param {string} filePath - Путь к файлу со ссылками.
 * @returns {Promise<string[]>} - Массив ссылок.
 */
async function getLinksFromFile(filePath) {
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const lines = fileContent.trim().split('\n').filter(line => line.trim() !== '');

    if (lines.length === 1 && (lines[0].startsWith('http://') || lines[0].startsWith('https://'))) {
        console.log(`Detected subscription link. Fetching from: ${lines[0]}`);
        try {
            const response = await axios.get(lines[0], { timeout: REQUEST_TIMEOUT });
            // Подписки могут быть в base64
            let decodedContent;
            try {
                decodedContent = Buffer.from(response.data, 'base64').toString('utf-8');
            } catch (e) {
                decodedContent = response.data; // Если не base64, используем как есть
            }
            return decodedContent.trim().split('\n').filter(link => link.trim() !== '');
        } catch (error) {
            throw new Error(`Failed to fetch subscription: ${error.message}`);
        }
    }
    
    return lines;
}

/**
 * Тестирует один прокси.
 * @param {string} link - Ссылка на прокси.
 * @returns {Promise<object>} - Объект с результатами теста.
 */
async function testProxy(link) {
    const name = link.split('#')[1] || 'Unnamed';
    const baseResult = {
        name,
        full_link: link,
        ip_address: "N/A",
        country_code: "N/A",
        city: "N/A",
        asn_organization: "N/A",
        asn_number: "N/A",
        ping_ms: "N/A",
        download_mbps: "N/A",
        upload_mbps: "N/A",
        status: "error",
        error: "Test failed",
        timestamp: new Date().toISOString()
    };

    let singboxProcess;
    try {
        const configGenerated = await generateSingboxConfig(link);
        if (!configGenerated) {
            baseResult.error = "Failed to generate sing-box config. Unsupported protocol.";
            return baseResult;
        }

        singboxProcess = spawn('sing-box', ['run', '-c', SINGBOX_CONFIG_FILE]);
        
        // Даем sing-box время на запуск
        await new Promise(resolve => setTimeout(resolve, 3000)); 

        const testResults = [];
        
        // 1. Прогревочный запрос
        console.log(`[${name}] Running warm-up request...`);
        await runIpTest();

        // 2. Основные тесты
        console.log(`[${name}] Running main tests...`);
        let finalSuccess = false;
        let lastSuccessfulTest = null;

        const test1 = await runIpTest();
        testResults.push(test1.success);

        if (test1.success) {
            finalSuccess = true;
            lastSuccessfulTest = test1;
        } else {
            // Повторная попытка, если первый основной тест не удался
            console.log(`[${name}] Main test failed, retrying...`);
            const test2 = await runIpTest();
            testResults.push(test2.success);
            if (test2.success) {
                finalSuccess = true;
                lastSuccessfulTest = test2;
            }
        }

        // 3. Решающий тест, если результаты неоднозначны
        const successes = testResults.filter(Boolean).length;
        const failures = testResults.length - successes;
        if (successes > 0 && failures > 0) {
            console.log(`[${name}] Ambiguous result, running tie-breaker test...`);
            const test3 = await runIpTest();
            testResults.push(test3.success);
            if (test3.success) {
                lastSuccessfulTest = test3;
            }
        }

        const finalSuccessCount = testResults.filter(Boolean).length;
        if (testResults.length === 3) {
            finalSuccess = finalSuccessCount >= 2;
        } else {
            finalSuccess = finalSuccessCount >= 1;
        }

        if (finalSuccess && lastSuccessfulTest) {
            console.log(`[${name}] IP test successful.`);
            baseResult.status = "tested";
            baseResult.error = null;
            baseResult.ping_ms = lastSuccessfulTest.ping.toFixed(3);
            
            const locData = lastSuccessfulTest.data;
            baseResult.ip_address = locData?.ip || "N/A";
            baseResult.country_code = locData?.country_code || "N/A";
            baseResult.city = locData?.city || "N/A";
            baseResult.asn_organization = locData?.asn_organization || "N/A";
            baseResult.asn_number = locData?.asn_number || "N/A";

            // 4. Speedtest
            console.log(`[${name}] Running speedtest...`);
            try {
                const speed = await runSpeedTest();
                baseResult.download_mbps = speed.download.toFixed(2);
                baseResult.upload_mbps = speed.upload.toFixed(2);
            } catch (speedError) {
                console.error(`[${name}] Speedtest failed: ${speedError.message}`);
                baseResult.error = "Speedtest failed";
            }
        } else {
            console.log(`[${name}] IP test failed.`);
            baseResult.error = "IP test failed/timeout";
        }

    } catch (error) {
        console.error(`[${name}] An unexpected error occurred: ${error.message}`);
        baseResult.error = error.message;
    } finally {
        if (singboxProcess) {
            singboxProcess.kill();
        }
        try {
            await fs.unlink(SINGBOX_CONFIG_FILE);
        } catch (e) {
            // Игнорируем ошибку, если файла нет
        }
    }

    return baseResult;
}

/**
 * Генерирует конфигурационный файл для sing-box.
 * @param {string} link - Ссылка на прокси.
 * @returns {Promise<boolean>} - true если конфиг создан, false если нет.
 */
async function generateSingboxConfig(link) {
    const outbounds = await convertLinksToOutbounds(link);
    if (!outbounds || outbounds.length === 0) {
        return false;
    }

    const config = {
        log: {
            level: "warn",
            timestamp: true,
        },
        inbounds: [
            {
                type: "mixed",
                tag: "mixed-in",
                listen: "127.0.0.1",
                listen_port: PROXY_PORT,
            },
        ],
        outbounds: outbounds,
    };

    await fs.writeFile(SINGBOX_CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
}

/**
 * Выполняет один тестовый запрос для проверки IP.
 * @returns {Promise<{success: boolean, data: object|null, ping: number, error: string|null}>}
 */
async function runIpTest() {
    const agent = new HttpsProxyAgent(PROXY_ADDRESS);
    const startTime = process.hrtime.bigint();

    try {
        const response = await axios.get(TEST_URL, {
            httpsAgent: agent,
            timeout: REQUEST_TIMEOUT,
        });
        const endTime = process.hrtime.bigint();
        const ping = Number(endTime - startTime) / 1e6; // в миллисекундах

        if (response.status === 200 && response.data.ip) {
            return { success: true, data: response.data, ping, error: null };
        }
        return { success: false, data: null, ping: 0, error: `Status code: ${response.status}` };
    } catch (error) {
        return { success: false, data: null, ping: 0, error: error.message };
    }
}

/**
 * Запускает тест скорости.
 * @returns {Promise<{download: number, upload: number}>} - Скорость в Mbps.
 */
async function runSpeedTest() {
    try {
        const result = await speedtest({
            acceptLicense: true,
            acceptGdpr: true,
            proxy: PROXY_ADDRESS, // Передаем прокси в speedtest
        });
        return {
            download: result.download.bandwidth * 8 / 1e6, // to Mbps
            upload: result.upload.bandwidth * 8 / 1e6,     // to Mbps
        };
    } catch (err) {
        throw new Error(`Speedtest execution failed: ${err.message}`);
    }
}

/**
 * Сохраняет массив результатов в JSON файл с временной меткой.
 * @param {object[]} results - Массив объектов с результатами.
 */
async function saveResultsToJson(results) {
    const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, -5) + 'Z';
    const filename = `tested-${timestamp}.json`;
    await fs.writeFile(filename, JSON.stringify(results, null, 2));
    console.log(`Results saved to ${filename}`);
}

// Запускаем главную функцию
main().catch(err => {
    console.error("A critical error occurred in the main function:", err);
    process.exit(1);
});
