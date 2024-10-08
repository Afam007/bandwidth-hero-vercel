const axios = require('axios');
const { pick } = require('lodash');
const zlib = require('node:zlib');
const lzma = require('lzma-native');
const { ZstdCodec } = require('zstd-codec');
const shouldCompress = require('./shouldCompress');
const redirect = require('./redirect');
const compress = require('./compress');
const bypass = require('./bypass');
const copyHeaders = require('./copyHeaders');
const http2 = require('node:http2');
const https = require('node:https');
const Bottleneck = require('bottleneck');
const cloudscraper = require('cloudscraper');

// Decompression utility function
async function decompress(data, encoding) {
    const decompressors = {
        gzip: () => zlib.promises.gunzip(data),
        br: () => zlib.promises.brotliDecompress(data),
        deflate: () => zlib.promises.inflate(data),
        lzma: () => new Promise((resolve, reject) => {
            lzma.decompress(data, (result, error) => error ? reject(error) : resolve(result));
        }),
        lzma2: () => new Promise((resolve, reject) => {
            lzma.decompress(data, (result, error) => error ? reject(error) : resolve(result));
        }),
        zstd: () => new Promise((resolve, reject) => {
            ZstdCodec.run(zstd => {
                try {
                    const simple = new zstd.Simple();
                    resolve(simple.decompress(data));
                } catch (error) {
                    reject(error);
                }
            });
        }),
    };

    if (decompressors[encoding]) {
        return decompressors[encoding]();
    } else {
        console.warn(`Unknown content-encoding: ${encoding}`);
        return data;
    }
}

// HTTP/2 request handling
async function makeHttp2Request(config) {
    return new Promise((resolve, reject) => {
        const client = http2.connect(config.url.origin);
        const headers = {
            ':method': 'GET',
            ':path': config.url.pathname,
            ...pick(config.headers, ['cookie', 'dnt', 'referer']),
            'user-agent': config.headers['user-agent'],
        };

        const req = client.request(headers);
        let data = [];

        req.on('response', (headers, flags) => {
            data = []; // Clear data on each new response
        });
        req.on('data', chunk => data.push(chunk));
        req.on('end', () => resolve(Buffer.concat(data)));
        req.on('error', err => reject(err));

        req.end();
    });
}

// Create a limiter with a maximum of 1 request every 2 seconds
const limiter = new Bottleneck({
    minTime: 2000, // Minimum time between requests in milliseconds
});

async function makeRequest(config) {
    return limiter.schedule(() => axios(config));
}

// Enhanced cloudscraper handling function
async function makeCloudscraperRequest(config, retries = 3) {
    const ciphers = [
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'DHE-RSA-AES128-GCM-SHA256',
        'DHE-RSA-AES256-GCM-SHA384'
    ].join(':');

    const agent = new https.Agent({
        ciphers,
        honorCipherOrder: true,
        secureOptions: https.constants.SSL_OP_NO_TLSv1 | https.constants.SSL_OP_NO_TLSv1_1, // Disable older versions of TLS
        keepAlive: true,
    });

    return new Promise((resolve, reject) => {
        cloudscraper.get({
            uri: config.url.href,
            headers: config.headers,
            gzip: true,
            encoding: null, // Get the raw buffer data
            cloudflareTimeout: 5000,
            decodeEmails: true,   // Decodes Cloudflare email obfuscation
            agentOptions: {
                httpsAgent: agent
            },
            timeout: config.timeout || 10000  // Global timeout (10 seconds by default)
        }, (error, response, body) => {
            if (error) {
                if (retries > 0) {
                    console.warn(`Cloudscraper request failed. Retrying... Attempts left: ${retries}`);
                    return resolve(makeCloudscraperRequest(config, retries - 1));  // Retry
                }
                console.error(`Cloudscraper failed after retries: ${error.message}`);
                return reject(new Error('Cloudscraper Request Failed'));
            } else {
                resolve({ headers: response.headers, data: body });
            }
        });
    });
}

// Proxy function to handle requests
async function proxy(req, res) {
    const config = {
        url: new URL(req.params.url),
        method: 'get',
        headers: {
            ...pick(req.headers, ['cookie', 'referer']),
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/*,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'DNT': '1',
            'x-forwarded-for': req.headers['x-forwarded-for'] || req.ip,
            'Connection': 'keep-alive',  // Often required for persistent connections
            'Pragma': 'no-cache',          // An additional header that can help in some cases
            'Sec-Fetch-Mode': 'navigate',  // Useful for navigation requests
            'Sec-Fetch-Site': 'same-origin',// Indicate the request's context
            'Sec-Fetch-User': '?1',        // To indicate that this is a user-initiated request
            via: '2.0 bandwidth-hero',
        },
        timeout: 5000,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        validateStatus: status => status < 500,
    };

    try {
        let originResponse;

        // First attempt regular request (either HTTP/1 or HTTP/2)
        if (config.url.protocol === 'http2:') {
            originResponse = await makeHttp2Request(config);
        } else {
            originResponse = await makeRequest(config); // Use the rate-limited request
        }

        // Check for Cloudflare status codes
        if (originResponse.status === 403 || originResponse.status === 503) {
            console.log('Cloudflare detected, retrying with cloudscraper...');
            originResponse = await makeCloudscraperRequest(config); // Fallback to cloudscraper
        }

        const { headers, data } = originResponse;
        const contentEncoding = headers['content-encoding'];
        let decompressedData = contentEncoding ? await decompress(data, contentEncoding) : data;

        copyHeaders(originResponse, res, {
            additionalExcludedHeaders: ['x-custom-header'],
            transformFunction: (key, value) => key === 'x-transform-header' ? value.toUpperCase() : value,
            overwriteExisting: false,
            mergeArrays: true
        });


        // Set additional headers
        res.set('X-Proxy', 'Cloudflare Worker');
        res.set('Access-Control-Allow-Origin', '*'); // Allow CORS if needed

        res.setHeader('content-encoding', 'identity');
        req.params.originType = headers['content-type'] || '';
        req.params.originSize = decompressedData.length;

        if (shouldCompress(req, decompressedData)) {
            compress(req, res, decompressedData);
        } else {
            bypass(req, res, decompressedData);
        }
    } catch (error) {
        if (error.response) {
            console.error(`Server responded with status: ${error.response.status}`);
        } else if (error.request) {
            console.error('No response received:', error.request);
        } else {
            console.error('Error setting up request:', error.message);
        }
        redirect(req, res);
    }
}

module.exports = proxy;
