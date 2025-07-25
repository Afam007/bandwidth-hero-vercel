import sharp from 'sharp';

// Test if we can create individual AVIF tiles
async function testTiling() {
    try {
        const width = 100;
        const height = 17000; // Slightly taller than MAX_DIMENSION
        const MAX_DIMENSION = 16383;
        
        console.log(`Creating test image ${width}x${height}`);
        
        // Create a test image
        const testImage = sharp({
            create: {
                width: width,
                height: height,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 1 }
            }
        });
        
        // Calculate tiles
        const tiles = [];
        let currentTop = 0;
        while (currentTop < height) {
            const remainingHeight = height - currentTop;
            const tileHeight = Math.min(MAX_DIMENSION, remainingHeight);
            
            tiles.push({
                left: 0,
                top: currentTop,
                width: width,
                height: tileHeight
            });
            
            currentTop += tileHeight;
        }
        
        console.log(`Will create ${tiles.length} tiles`);
        tiles.forEach((tile, i) => {
            console.log(`Tile ${i}: ${tile.width}x${tile.height} at (${tile.left}, ${tile.top})`);
        });
        
        // Test extracting and converting each tile
        const tileBuffers = [];
        for (let i = 0; i < tiles.length; i++) {
            const tile = tiles[i];
            console.log(`Processing tile ${i}...`);
            
            try {
                const tileBuffer = await testImage
                    .clone()
                    .extract(tile)
                    .avif({ quality: 75 })
                    .toBuffer();
                
                console.log(`Tile ${i} created successfully: ${tileBuffer.length} bytes`);
                tileBuffers.push(tileBuffer);
            } catch (error) {
                console.error(`Error processing tile ${i}:`, error.message);
                break;
            }
        }
        
        console.log(`Successfully created ${tileBuffers.length} tiles`);
        
        // Try to reassemble (this is where it might fail)
        if (tileBuffers.length === tiles.length) {
            console.log('Attempting to reassemble...');
            
            // Simple reassembly test - just try with PNG first
            let currentImage = sharp(tileBuffers[0]);
            
            for (let i = 1; i < tileBuffers.length; i++) {
                console.log(`Combining tile ${i}...`);
                const currentMeta = await currentImage.metadata();
                const nextTileMeta = await sharp(tileBuffers[i]).metadata();
                
                console.log(`Current image: ${currentMeta.width}x${currentMeta.height}`);
                console.log(`Next tile: ${nextTileMeta.width}x${nextTileMeta.height}`);
                
                const combinedHeight = currentMeta.height + nextTileMeta.height;
                console.log(`Combined height will be: ${combinedHeight}`);
                
                currentImage = sharp({
                    create: {
                        width: width,
                        height: combinedHeight,
                        channels: 4,
                        background: { r: 255, g: 255, b: 255, alpha: 1 }
                    }
                })
                .composite([
                    { input: await currentImage.toBuffer(), top: 0, left: 0 },
                    { input: tileBuffers[i], top: currentMeta.height, left: 0 }
                ]);
            }
            
            console.log('Testing PNG output...');
            const pngResult = await currentImage.png().toBuffer();
            console.log(`PNG result: ${pngResult.length} bytes`);
            
            console.log('Testing AVIF output...');
            try {
                const avifResult = await currentImage.avif({ quality: 75 }).toBuffer();
                console.log(`AVIF result: ${avifResult.length} bytes`);
                console.log('SUCCESS: Tiling and reassembly worked!');
            } catch (error) {
                console.error('AVIF conversion failed:', error.message);
            }
        }
        
    } catch (error) {
        console.error('Test failed:', error);
    }
}

testTiling();