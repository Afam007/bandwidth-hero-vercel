import sharp from 'sharp';
import compress from './src/compress.js';

// Create a test image that's taller than 16383px
async function createTestImage() {
    const width = 100;
    const height = 16400; // Just over the threshold - should trigger tiling
    
    const testImage = sharp({
        create: {
            width: width,
            height: height,
            channels: 4,
            background: { r: 255, g: 0, b: 0, alpha: 1 }
        }
    }).png();
    
    return await testImage.toBuffer();
}

// Mock request and response objects
function createMockReq() {
    return {
        params: {
            url: 'https://example.com/test.png',
            originSize: 100000
        }
    };
}

function createMockRes() {
    let headers = {};
    let statusCode = 200;
    let body = null;
    
    const mockRes = {
        setHeader: (key, value) => { headers[key] = value; },
        hasHeader: (key) => headers.hasOwnProperty(key),
        removeHeader: (key) => { delete headers[key]; },
        status: function(code) { statusCode = code; return this; },
        end: function(data) { body = data; return this; },
        send: function(data) { body = data; return this; },
        json: function(data) { body = JSON.stringify(data); return this; },
        headersSent: false,
        get headers() { return headers; },
        get statusCode() { return statusCode; },
        get body() { return body; }
    };
    
    return mockRes;
}

async function testCompression() {
    try {
        console.log('Creating test image...');
        const testImageBuffer = await createTestImage();
        console.log(`Test image created: ${testImageBuffer.length} bytes`);
        
        const req = createMockReq();
        const res = createMockRes();
        
        console.log('Running compression...');
        await compress(req, res, testImageBuffer);
        
        console.log('Compression completed!');
        console.log(`Output size: ${res.body ? res.body.length : 'null'} bytes`);
        console.log(`Status: ${res.statusCode}`);
        console.log('Headers:', res.headers);
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

testCompression();