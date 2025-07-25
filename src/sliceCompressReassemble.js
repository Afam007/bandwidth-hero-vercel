import sharp from 'sharp';

const MAX_DIMENSION = 16383;

/**
 * Slice an image buffer vertically or horizontally, compress each slice to webp, and reassemble.
 * Only slices in one direction per image - vertically if width > MAX_DIMENSION, 
 * horizontally if height > MAX_DIMENSION.
 * 
 * @param {Buffer} inputBuffer - Input image buffer
 * @param {Object} metadata - Image metadata from sharp
 * @param {Object} options - Compression options
 * @returns {Promise<{buffer: Buffer, format: string}>} - Reassembled image buffer and format
 */
async function sliceCompressReassemble(inputBuffer, metadata, options = {}) {
    const { width, height } = metadata;
    const { quality = 75, grayscale = false } = options;

    // Determine slicing direction - only slice in one direction
    const shouldSliceVertically = width > MAX_DIMENSION;
    const shouldSliceHorizontally = height > MAX_DIMENSION && !shouldSliceVertically;
    
    if (!shouldSliceVertically && !shouldSliceHorizontally) {
        throw new Error('Image does not exceed MAX_DIMENSION, slicing not needed');
    }

    let slices;
    let sliceInfo;

    if (shouldSliceVertically) {
        sliceInfo = await sliceVertically(inputBuffer, metadata, quality, grayscale);
    } else {
        sliceInfo = await sliceHorizontally(inputBuffer, metadata, quality, grayscale);
    }

    // Reassemble slices into final image
    const result = await reassembleSlices(sliceInfo.slices, sliceInfo.metadata, shouldSliceVertically);
    
    return result;
}

/**
 * Slice image vertically into strips and compress each to webp
 */
async function sliceVertically(inputBuffer, metadata, quality, grayscale) {
    const { width, height } = metadata;
    const numSlices = Math.ceil(width / MAX_DIMENSION);
    const sliceWidth = Math.floor(width / numSlices);
    const slices = [];

    for (let i = 0; i < numSlices; i++) {
        const left = i * sliceWidth;
        const actualWidth = (i === numSlices - 1) ? width - left : sliceWidth;
        
        let sliceProcessor = sharp(inputBuffer)
            .extract({ left, top: 0, width: actualWidth, height });
            
        if (grayscale) {
            sliceProcessor = sliceProcessor.grayscale();
        }
        
        const sliceBuffer = await sliceProcessor
            .webp({ quality, alphaQuality: 80 })
            .toBuffer();
            
        slices.push({
            buffer: sliceBuffer,
            width: actualWidth,
            height,
            left,
            top: 0
        });
    }

    return {
        slices,
        metadata: {
            totalWidth: width,
            totalHeight: height,
            direction: 'vertical'
        }
    };
}

/**
 * Slice image horizontally into strips and compress each to webp
 */
async function sliceHorizontally(inputBuffer, metadata, quality, grayscale) {
    const { width, height } = metadata;
    const numSlices = Math.ceil(height / MAX_DIMENSION);
    const sliceHeight = Math.floor(height / numSlices);
    const slices = [];

    for (let i = 0; i < numSlices; i++) {
        const top = i * sliceHeight;
        const actualHeight = (i === numSlices - 1) ? height - top : sliceHeight;
        
        let sliceProcessor = sharp(inputBuffer)
            .extract({ left: 0, top, width, height: actualHeight });
            
        if (grayscale) {
            sliceProcessor = sliceProcessor.grayscale();
        }
        
        const sliceBuffer = await sliceProcessor
            .webp({ quality, alphaQuality: 80 })
            .toBuffer();
            
        slices.push({
            buffer: sliceBuffer,
            width,
            height: actualHeight,
            left: 0,
            top
        });
    }

    return {
        slices,
        metadata: {
            totalWidth: width,
            totalHeight: height,
            direction: 'horizontal'
        }
    };
}

/**
 * Reassemble webp slices back into a single image
 * Uses JPEG format for final output when dimensions exceed WebP limits
 */
async function reassembleSlices(slices, reassembleMetadata, isVertical) {
    const { totalWidth, totalHeight } = reassembleMetadata;
    
    // WebP has a maximum dimension limit of 16383, so use JPEG for larger images
    const useJpeg = totalWidth > MAX_DIMENSION || totalHeight > MAX_DIMENSION;
    
    // Create a blank canvas
    const canvas = sharp({
        create: {
            width: totalWidth,
            height: totalHeight,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
    });

    // Prepare composite operations for all slices
    const compositeOperations = slices.map(slice => ({
        input: slice.buffer,
        left: slice.left,
        top: slice.top
    }));

    // Composite all slices onto the canvas and output in appropriate format
    let outputProcessor = canvas.composite(compositeOperations);
    
    if (useJpeg) {
        const buffer = await outputProcessor
            .jpeg({ quality: 85, mozjpeg: true })
            .toBuffer();
        return { buffer, format: 'jpeg' };
    } else {
        const buffer = await outputProcessor
            .webp({ quality: 90, alphaQuality: 80 })
            .toBuffer();
        return { buffer, format: 'webp' };
    }
}

export default sliceCompressReassemble;