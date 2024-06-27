const fs = require('fs');
const path = require('path');
const url = require('url');
const axios = require('axios');
const pick = require('lodash').pick;
const zlib = require('node:zlib');
const lzma = require('lzma-native'); // for LZMA/LZMA2
const ZstdCodec = require('zstd-codec').ZstdCodec; // for Zstandard
const shouldCompress = require('./shouldCompress');
const redirect = require('./redirect');
const compress = require('./compress');
const bypass = require('./bypass');
const copyHeaders = require('./copyHeaders');
const {HttpsProxyAgent} = require('https-proxy-agent');



var gettingCookie = false ;



function readAllCFClearanceCookies() {

    const cookiePath = path.join(__dirname, 'cf_clearance_cookies.json');

    try {

        if (fs.existsSync(cookiePath)) {

            const cookiesContent = fs.readFileSync(cookiePath, 'utf8');

            return JSON.parse(cookiesContent);

        }

    } catch (error) {

        console.error('Error reading cf_clearance cookies:', error);

    }

    return {};

}





function saveCFClearanceCookie(domain, cookieValue) {

    const cookiePath = path.join(__dirname, 'cf_clearance_cookies.json');

    const cookies = readAllCFClearanceCookies();

    cookies[domain] = cookieValue;

    try {

        fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));

    } catch (error) {

        console.error(`Error saving cf_clearance cookie for ${domain}:`, error);

    }

}



 function getBaseDomain(url) {

     

     const parsedUrl = new URL(url);

     const parts = parsedUrl.hostname.split('.');

     const baseDomain = parts.slice(-2).join('.');

     

      return `${parsedUrl.protocol}//${baseDomain}`;

    

  }

  

function getBaseUrl(url) {

	

  const parsedUrl = new URL(url);

  return `${parsedUrl.protocol}//${parsedUrl.hostname}`;

}





async function proxy(req, res) {
	
	var domain = getBaseDomain(req.params.url);

    var referer = req.headers.referer;

	

	if (referer) {

		

	     domain = getBaseUrl(req.headers.referer);

	

         req.headers.referer = domain;



	} 

	

    const cookies = readAllCFClearanceCookies();

    const cfClearanceValue = cookies[domain];

           

     if (cfClearanceValue) {

     	

           console.log(`Using saved cookie for ${domain}`);

           req.headers.cookie = `cf_clearance=${cfClearanceValue}`;

       }	
       
       
    var config = {
        url: req.params.url,
        method: 'get',
        headers: {
            ...pick(req.headers, ['cookie', 'dnt', 'referer']),
            'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'Accept-Encoding': 'gzip, deflate, br, lzma, lzma2, zstd'
        },
        timeout: 25000,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        httpsAgent: new HttpsProxyAgent(`http://${process.env.PROXY_USER}:${process.env.PROXY_PASS}@${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`),
        validateStatus: status => status < 500,
        transformResponse: [(data, headers) => {
            if (headers['content-encoding'] === 'gzip') {
                return zlib.gunzipSync(data);
            }
            else if (headers['content-encoding'] === 'deflate') {
                return zlib.inflateSync(data);
            }
            else if (headers['content-encoding'] === 'br') {
                return zlib.brotliDecompressSync(data);
            }
            else if (headers['content-encoding'] === 'lzma') {
                return lzma.decompressSync(data);
            }
            else if (headers['content-encoding'] === 'lzma2') {
                return lzma.decompressSync(data);
            }
            else if (headers['content-encoding'] === 'zstd') {
                // For Zstandard, we use a synchronous call in a slightly different way
                // because the 'zstd-codec' library primarily provides asynchronous methods.
                let result;
                ZstdCodec.run(zstd => {
                    const simple = new zstd.Simple();
                    result = simple.decompress(data);
                });
                return result;
            }
            else{
                /*Do Nothing*/
            }
            return data;
        }],
    };

    try {
        var origin = await axios(config);
        
        console.log(`Status Code: ${origin.status}`);

         if (origin.status === 403 ) {

		            

              if (gettingCookie) return ;

         

              gettingCookie = true ;

              console.log("Cloudflare Bypass");

              

              const flaresolverrResponse = await axios({

                  method: 'POST',

                  url: process.env.FLARE_URL,

                  data: {

                     cmd: 'request.get',
                     url: domain
     
                 }

            });

            

               gettingCookie = false ;

            

                 if (flaresolverrResponse.data && flaresolverrResponse.data.solution && flaresolverrResponse.data.solution.cookies) {

                 	

                       const cfCookie = flaresolverrResponse.data.solution.cookies.find(cookie => cookie.name === 'cf_clearance');

                       

                       if (cfCookie) {

                       	

                           console.log(`Saving cookie for ${domain}`);

                           saveCFClearanceCookie(domain, cfCookie.value);

                

                           config.headers.cookie = `cf_clearance=${cfCookie.value}`;

                

                           origin = await axios(config);

                         }

                     }

            }


        copyHeaders(origin, res);
        res.setHeader('content-encoding', 'identity');
        req.params.originType = origin.headers['content-type'] || '';
        req.params.originSize = origin.data.length;

        const contentEncoding = origin.headers['content-encoding'];
        if (contentEncoding) {
            switch (contentEncoding) {
                case 'gzip':
                    origin.data = await gunzip(origin.data);
                    break;
                case 'br':
                    origin.data = await brotliDecompress(origin.data);
                    break;
                case 'deflate':
                    origin.data = await inflate(origin.data); // Corrected to "inflate" for clarity
                    break;
                case 'lzma':
                    origin.data = await lzmaDecompress(origin.data);
                    break;
                case 'lzma2': // Adjust based on the actual content-encoding header value for LZMA2
                    origin.data = await lzmaDecompress(origin.data);
                    break;
                case 'zstd':
                    origin.data = await zstdDecompress(origin.data);
                    break;
                default:
                    console.warn(`Unknown content-encoding: ${contentEncoding}`);
            }
        }

        if (shouldCompress(req, origin.data)) {
            compress(req, res, origin.data);
        } else {
            bypass(req, res, origin.data);
        }
    } catch (error) {
        if (error.response) {
            // The request was made, and the server responded with a status code outside of the range of 2xx
            console.error('Server responded with status:', error.response.status);
        } else if (error.request) {
            // The request was made, but no response was received
            console.error('No response received:', error.request);
        } else {
            // Something happened in setting up the request and triggered an Error
            console.error('Error setting up request:', error.message);
        }
        redirect(req, res);  // You might also consider forwarding the error details
    }
}

// For gzip decompression
function gunzip(data) {
    return new Promise((resolve, reject) => {
        zlib.gunzip(data, (error, decompressed) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(decompressed);
        });
    });
}

// For Brotli decompression
function brotliDecompress(data) {
    return new Promise((resolve, reject) => {
        zlib.brotliDecompress(data, (error, decompressed) => { // Using built-in Brotli support in zlib
            if (error) {
                reject(error);
                return;
            }
            resolve(decompressed);
        });
    });
}

// For deflate decompression (actually "inflate")
function inflate(data) {
    return new Promise((resolve, reject) => {
        zlib.inflate(data, (error, decompressed) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(decompressed);
        });
    });
}

// For LZMA/LZMA2 decompression
function lzmaDecompress(data) {
    return new Promise((resolve, reject) => {
        lzma.decompress(data, (result, error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(result);
        });
    });
}

// For Zstandard decompression
function zstdDecompress(data) {
    return new Promise((resolve, reject) => {
        ZstdCodec.run(zstd => {
            try {
                const simple = new zstd.Simple();
                const decompressed = simple.decompress(data);
                resolve(decompressed);
            } catch (error) {
                reject(error);
            }
        });
    });
}

module.exports = proxy;
