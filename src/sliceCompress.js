import sharp from 'sharp';
const MAX_DIMENSION = 16382;

/**
 * Slice an image vertically or horizontally if it exceeds MAX_DIMENSION,
 * compress each slice to webp, and reassemble into the original layout.
 * Only slices in one direction (no tiling).
 *
 * @param {Buffer} inputBuffer - The image buffer.
 * @param {Object} opts - Options (supports { quality }).
 * @returns {Promise<Buffer>} - The reassembled webp buffer.
 */
export async function sliceCompress(inputBuffer, formatOpts) {
    const meta = await sharp(inputBuffer, { animated: true }).metadata();

    // Determine if slicing is needed
    let slices = [];
    let direction = null;
    let numSlices = 1;
    let sliceSize = 0;
    let totalSize = 0;

    if (meta.width > MAX_DIMENSION) {
        direction = 'vertical';
        numSlices = Math.ceil(meta.width / MAX_DIMENSION);
        sliceSize = MAX_DIMENSION;
        totalSize = meta.width;
    } else if (meta.height > MAX_DIMENSION) {
        direction = 'horizontal';
        numSlices = Math.ceil(meta.height / MAX_DIMENSION);
        sliceSize = MAX_DIMENSION;
        totalSize = meta.height;
    } else {
        // No slicing needed, just compress to webp
        return sharp(inputBuffer)
            .toFormat('webp', formatOpts)
            .toBuffer();
    }

    // Extract, compress, and store each slice
    for (let i = 0; i < numSlices; i++) {
        let extractOpts;
        if (direction === 'vertical') {
            extractOpts = {
                left: i * sliceSize,
                top: 0,
                width: Math.min(sliceSize, totalSize - i * sliceSize),
                height: meta.height,
            };
        } else {
            extractOpts = {
                left: 0,
                top: i * sliceSize,
                width: meta.width,
                height: Math.min(sliceSize, totalSize - i * sliceSize),
            };
        }
        
        const slice = await sharp(inputBuffer)
            .extract(extractOpts)
            .toFormat('webp', formatOpts)
            .toBuffer();
        slices.push({ slice, extractOpts });
    }
    
    // Reassemble
    let compositeBase = sharp({
        create: {
            width: meta.width,
            height: meta.height,
            channels: meta.channels,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
    });
    
    compositeBase = compositeBase.composite(
        slices.map(({ slice, extractOpts }) => ({
            input: slice,
            left: direction === 'vertical' ? extractOpts.left : 0,
            top: direction === 'horizontal' ? extractOpts.top : 0
        }))
    );
    
    return await compositeBase.toFormat('webp', formatOpts).toBuffer({ resolveWithObject: true });
}
