import { promises as fs } from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { convertLinksToOutbounds } from 'singbox-converter';
import fetch from 'node-fetch';

// --- КОНФИГУРАЦИЯ ---
const LINKS_FILE_PATH = 'links.txt';
const TEST_URL = 'https://ip.oxylabs.io/location';
const SINGBOX_CONFIG_DIR = './singbox_configs';
const SINGBOX_PATH = './sing-box'; // Путь к исполняемому файлу sing-box
const PROXY_PORT = 2080;
const TIMEOUT_MS = 15000; // 15 секунд

/**
 * Главная функция для запуска всего процесса.
 */
async function main() {
    console.log('Начало процесса тестирования прокси...');
    try {
        await fs.mkdir(SINGBOX_CONFIG_DIR, { recursive: true });
        const links = await getLinks();
        if (!links || links.length === 0) {
            console.log('Файл links.txt пуст или не содержит ссылок. Завершение работы.');
            return;
        }

        console.log(`Найдено ${links.length} ссылок для тестирования.`);
        const results = [];

        for (const link of links) {
            if (!link.trim()) continue;
            const result = await testProxy(link);
            results.push(result);
            console.log(`Тестирование завершено для: ${result.name || link}. Статус: ${result.status}`);
        }

        await saveResults(results);
    } catch (error) {
        console.error('Произошла критическая ошибка в главном процессе:', error);
    } finally {
        await fs.rm(SINGBOX_CONFIG_DIR, { recursive: true, force: true });
        console.log('Временные файлы конфигурации удалены.');
    }
}

/**
 * Читает ссылки из файла links.txt.
 * Если в файле одна http/https ссылка, загружает список по ней.
 * @returns {Promise<string[]>} Массив ссылок.
 */
async function getLinks() {
    try {
        const data = await fs.readFile(LINKS_FILE_PATH, 'utf-8');
        const lines = data.trim().split(/\r?\n/);

        if (lines.length === 1 && lines[0].match(/^https?:\/\//)) {
            console.log('Обнаружена ссылка на подписку. Загрузка...');
            const response = await fetch(lines[0]);
            if (!response.ok) {
                throw new Error(`Не удалось загрузить подписку. Статус: ${response.status}`);
            }
            const subscriptionData = await response.text();
            return subscriptionData.trim().split(/\r?\n/);
        }
        return lines;
    } catch (error) {
        console.error(`Ошибка при чтении файла ${LINKS_FILE_PATH}:`, error);
        return [];
    }
}

/**
 * Тестирует один прокси-сервер.
 * @param {string} link - Ссылка на прокси.
 * @returns {Promise<object>} Объект с результатами тестирования.
 */
async function testProxy(link) {
    const name = link.split('#')[1] || 'N/A';
    const baseResult = {
        name: decodeURIComponent(name),
        link: link,
        status: 'error',
        ip_address: "N/A",
        country_code: "N/A",
        city: "N/A",
        asn_organization: "N/A",
        asn_number: "N/A",
        ping_ms: "N/A",
        download_mbps: "N/A",
        upload_mbps: "N/A",
        error: "Unknown error",
        timestamp: new Date().toISOString()
    };

    let singboxProcess = null;
    const configPath = path.join(SINGBOX_CONFIG_DIR, `config-${Date.now()}.json`);

    try {
        // 1. Создание конфигурации для sing-box
        const singboxConfig = await createSingboxConfig(link);
        if (!singboxConfig) {
            baseResult.error = "Failed to convert link to sing-box config.";
            return baseResult;
        }
        await fs.writeFile(configPath, JSON.stringify(singboxConfig, null, 2));

        // 2. Запуск sing-box
        singboxProcess = spawn(SINGBOX_PATH, ['run', '-c', configPath]);
        
        // Добавляем обработчики для отладки
        singboxProcess.stdout.on('data', (data) => console.log(`sing-box stdout: ${data.toString().trim()}`));
        singboxProcess.stderr.on('data', (data) => console.error(`sing-box stderr: ${data.toString().trim()}`));

        await new Promise(resolve => setTimeout(resolve, 2000)); // Даем время на запуск

        // 3. Проверка работоспособности (Health Check)
        const healthCheckResult = await performHealthCheck();
        if (!healthCheckResult.success) {
            baseResult.error = healthCheckResult.error;
            return baseResult;
        }
        
        // Заполняем данные из успешной проверки
        const locationData = healthCheckResult.data;
        baseResult.ping_ms = healthCheckResult.ping;
        baseResult.ip_address = locationData?.ip || "N/A";
        baseResult.country_code = locationData?.country_code || "N/A";
        baseResult.city = locationData?.city || "N/A";
        baseResult.asn_organization = locationData?.asn_org || "N/A";
        baseResult.asn_number = locationData?.asn?.toString() || "N/A";

        // 4. Тест скорости
        console.log(`Прокси ${name} рабочий. Запуск speedtest...`);
        const speedTestResult = await runSpeedTest();
        if (speedTestResult.success) {
            baseResult.download_mbps = (speedTestResult.download / 1_000_000 * 8).toFixed(2);
            baseResult.upload_mbps = (speedTestResult.upload / 1_000_000 * 8).toFixed(2);
            baseResult.status = 'working';
            baseResult.error = null;
        } else {
            baseResult.error = speedTestResult.error;
        }

    } catch (error) {
        console.error(`Ошибка при тестировании ${name}:`, error);
        baseResult.error = error.message;
    } finally {
        if (singboxProcess) {
            singboxProcess.kill();
        }
    }
    return baseResult;
}

/**
 * Создает JSON-конфигурацию для sing-box.
 * @param {string} link - Ссылка на прокси.
 * @returns {Promise<object|null>} Конфигурационный объект.
 */
async function createSingboxConfig(link) {
    try {
        const outbounds = await convertLinksToOutbounds(link);
        if (!outbounds || outbounds.length === 0) return null;

        const outbound = outbounds[0];
        outbound.tag = 'proxy-out';

        return {
            log: { "level": "warn" },
            inbounds: [{
                type: 'socks',
                tag: 'socks-in',
                listen: '127.0.0.1',
                listen_port: PROXY_PORT
            }],
            outbounds: [outbound],
            route: {
                rules: [{
                    inbound: ['socks-in'],
                    outbound: 'proxy-out'
                }]
            }
        };
    } catch (error) {
        console.error('Ошибка конвертации ссылки:', error);
        return null;
    }
}

/**
 * Выполняет curl-запрос через прокси для проверки.
 * @returns {Promise<{success: boolean, data: object|null, ping: string|null, error: string|null}>}
 */
async function runCurlTest() {
    const command = `curl --proxy socks5h://127.0.0.1:${PROXY_PORT} -s -w "\\n%{time_starttransfer}" --connect-timeout ${TIMEOUT_MS / 1000} -m ${TIMEOUT_MS / 1000} ${TEST_URL}`;
    
    return new Promise((resolve) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                resolve({ success: false, data: null, ping: null, error: `Curl error: ${error.message}` });
                return;
            }
            if (stderr) {
                resolve({ success: false, data: null, ping: null, error: `Curl stderr: ${stderr}` });
                return;
            }

            const parts = stdout.trim().split('\n');
            const body = parts.slice(0, -1).join('\n');
            const timeStartTransfer = parts[parts.length - 1];

            try {
                const jsonData = JSON.parse(body);
                const ping = (parseFloat(timeStartTransfer) * 1000).toFixed(3);
                resolve({ success: true, data: jsonData, ping: ping, error: null });
            } catch (e) {
                resolve({ success: false, data: null, ping: null, error: "Failed to parse JSON response from test URL." });
            }
        });
    });
}

/**
 * Реализует логику проверки работоспособности с 2-3 запросами.
 * @returns {Promise<{success: boolean, data: object|null, ping: string|null, error: string|null}>}
 */
async function performHealthCheck() {
    console.log('Запуск проверки работоспособности...');
    const test1 = await runCurlTest();
    if (!test1.success) {
        console.log('Первая проверка не удалась.');
        return { success: false, error: `Initial test failed: ${test1.error}` };
    }
    console.log('Первая проверка успешна. Запуск второй проверки...');
    
    const test2 = await runCurlTest();
    if (test2.success) {
        console.log('Вторая проверка успешна. Прокси рабочий.');
        return { success: true, data: test2.data, ping: test2.ping, error: null };
    }

    console.log('Вторая проверка не удалась. Запуск третьей решающей проверки...');
    const test3 = await runCurlTest();
    if (test3.success) {
        console.log('Третья проверка успешна. Прокси рабочий.');
        return { success: true, data: test3.data, ping: test3.ping, error: null };
    } else {
        console.log('Третья проверка не удалась. Прокси нерабочий.');
        return { success: false, error: `Second and third tests failed: ${test3.error}` };
    }
}

/**
 * Запускает speedtest-cli через прокси.
 * @returns {Promise<{success: boolean, download: number, upload: number, error: string|null}>}
 */
async function runSpeedTest() {
    const command = `speedtest --accept-license --accept-gdpr --format=json --proxy=socks5://127.0.0.1:${PROXY_PORT}`;
    
    return new Promise((resolve) => {
        exec(command, { timeout: 120000 }, (error, stdout, stderr) => { // таймаут 2 минуты
            if (error) {
                resolve({ success: false, error: `Speedtest failed: ${error.message}` });
                return;
            }
            if (stderr && !stdout) { // Иногда speedtest пишет прогресс в stderr
                 console.warn(`Speedtest stderr: ${stderr}`);
            }
            try {
                const result = JSON.parse(stdout);
                if (result.type === 'result') {
                    resolve({
                        success: true,
                        download: result.download.bandwidth, // в байтах/с
                        upload: result.upload.bandwidth, // в байтах/с
                        error: null
                    });
                } else {
                     resolve({ success: false, error: `Speedtest error: ${result.error || 'Unknown error type'}` });
                }
            } catch (e) {
                resolve({ success: false, error: `Failed to parse speedtest JSON output. ${e.message}` });
            }
        });
    });
}

/**
 * Сохраняет результаты в JSON-файл с временной меткой.
 * @param {object[]} results - Массив с результатами.
 */
async function saveResults(results) {
    const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, -5) + 'Z';
    const filename = `tested-${timestamp}.json`;
    try {
        await fs.writeFile(filename, JSON.stringify(results, null, 2));
        console.log(`Результаты успешно сохранены в файл: ${filename}`);
    } catch (error) {
        console.error('Не удалось сохранить файл с результатами:', error);
    }
}

// Запуск главной функции
main();
