import sharp from 'sharp';

async function testAvifLimits() {
    // Test different heights to see where AVIF fails
    const testHeights = [16383, 16384, 17000, 20000];
    const width = 100;
    
    for (const height of testHeights) {
        console.log(`\nTesting ${width}x${height}:`);
        
        try {
            const image = sharp({
                create: {
                    width: width,
                    height: height,
                    channels: 3,
                    background: { r: 255, g: 0, b: 0 }
                }
            });
            
            // Test AVIF
            try {
                const avifBuffer = await image.avif({ quality: 50 }).toBuffer();
                console.log(`  AVIF: SUCCESS (${avifBuffer.length} bytes)`);
            } catch (error) {
                console.log(`  AVIF: FAILED - ${error.message}`);
            }
            
            // Test WebP as comparison
            try {
                const webpBuffer = await image.webp({ quality: 50 }).toBuffer();
                console.log(`  WebP: SUCCESS (${webpBuffer.length} bytes)`);
            } catch (error) {
                console.log(`  WebP: FAILED - ${error.message}`);
            }
            
            // Test PNG as comparison
            try {
                const pngBuffer = await image.png().toBuffer();
                console.log(`  PNG: SUCCESS (${pngBuffer.length} bytes)`);
            } catch (error) {
                console.log(`  PNG: FAILED - ${error.message}`);
            }
            
        } catch (error) {
            console.log(`  Image creation failed: ${error.message}`);
        }
    }
}

testAvifLimits();