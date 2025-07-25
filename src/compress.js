import sharp from 'sharp';
import redirect from './redirect.js';
import { URL } from 'url';
import sanitizeFilename from 'sanitize-filename';

const MAX_DIMENSION = 16383;
const LARGE_IMAGE_THRESHOLD = 4_000_000; // Use underscores for readability
const MEDIUM_IMAGE_THRESHOLD = 1_000_000;


/**
 * Check if an image needs tiling based on height
 * @param {Object} metadata - Image metadata from sharp
 * @returns {boolean} - True if image needs tiling
 */
function needsTiling(metadata) {
    return metadata.height > MAX_DIMENSION;
}

/**
 * Split an image into vertical tiles
 * @param {Sharp} sharpInstance - Sharp instance
 * @param {Object} metadata - Image metadata
 * @returns {Array} - Array of tile configurations
 */
function createTileConfig(metadata) {
    const tiles = [];
    const tileHeight = MAX_DIMENSION;
    let currentTop = 0;

    while (currentTop < metadata.height) {
        const remainingHeight = metadata.height - currentTop;
        const height = Math.min(tileHeight, remainingHeight);
        
        tiles.push({
            left: 0,
            top: currentTop,
            width: metadata.width,
            height: height
        });
        
        currentTop += height;
    }
    
    return tiles;
}

/**
 * Process each tile as AVIF
 * @param {Sharp} sharpInstance - Sharp instance
 * @param {Array} tiles - Array of tile configurations
 * @param {Object} formatOptions - Format options for AVIF
 * @returns {Array} - Array of processed tile buffers
 */
async function processTilesAsAvif(sharpInstance, tiles, formatOptions) {
    const tileBuffers = [];
    
    for (const tile of tiles) {
        const tileBuffer = await sharpInstance
            .clone()
            .extract(tile)
            .avif(formatOptions)
            .toBuffer();
        
        tileBuffers.push(tileBuffer);
    }
    
    return tileBuffers;
}

/**
 * Reassemble AVIF tiles vertically into a single image
 * @param {Array} tileBuffers - Array of tile buffers
 * @param {number} totalWidth - Total width of the final image
 * @param {number} totalHeight - Total height of the final image
 * @param {Object} formatOptions - Format options for final AVIF
 * @returns {Object} - Object with data and info, includes format used
 */
async function reassembleTiles(tileBuffers, totalWidth, totalHeight, formatOptions) {
    // For very tall images, we might need to be more careful about memory usage
    // Let's try a sequential approach by joining tiles one by one
    
    if (tileBuffers.length === 1) {
        // If only one tile, just return it
        return { data: tileBuffers[0], info: { size: tileBuffers[0].length }, format: 'avif' };
    }
    
    // Start with the first tile
    let currentImage = sharp(tileBuffers[0]);
    
    // Sequentially extend the image by joining tiles
    for (let i = 1; i < tileBuffers.length; i++) {
        const nextTile = sharp(tileBuffers[i]);
        const currentMeta = await currentImage.metadata();
        const nextMeta = await nextTile.metadata();
        
        // Create a new image that combines current + next tile
        const combinedHeight = currentMeta.height + nextMeta.height;
        
        currentImage = sharp({
            create: {
                width: totalWidth,
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
    
    // Try to convert final result to AVIF first
    try {
        const result = await currentImage.avif(formatOptions).toBuffer({ resolveWithObject: true });
        return { data: result.data, info: result.info, format: 'avif' };
    } catch (error) {
        // If AVIF fails due to size constraints, try WebP
        try {
            const result = await currentImage.webp({ quality: formatOptions.quality || 75 }).toBuffer({ resolveWithObject: true });
            return { data: result.data, info: result.info, format: 'webp' };
        } catch (webpError) {
            // If WebP also fails, fall back to PNG
            const result = await currentImage.png().toBuffer({ resolveWithObject: true });
            return { data: result.data, info: result.info, format: 'png' };
        }
    }
}

/**
 * Main image compression function with tiling support
 * @param {Sharp} sharpInstance - Sharp instance
 * @param {Object} metadata - Image metadata
 * @param {string} outputFormat - Output format
 * @param {Object} formatOptions - Format options
 * @param {boolean} isAnimated - Whether image is animated
 * @returns {Object} - Object with data, info, and actualFormat
 */
async function compressImage(sharpInstance, metadata, outputFormat, formatOptions, isAnimated) {
    // For animated images or non-AVIF formats, use standard processing
    if (isAnimated || outputFormat !== 'avif') {
        const result = await sharpInstance
            .toFormat(outputFormat, formatOptions)
            .toBuffer({ resolveWithObject: true });
        return { data: result.data, info: result.info, actualFormat: outputFormat };
    }
    
    // For AVIF images that need tiling
    if (needsTiling(metadata)) {
        const tiles = createTileConfig(metadata);
        const tileBuffers = await processTilesAsAvif(sharpInstance, tiles, formatOptions);
        const result = await reassembleTiles(tileBuffers, metadata.width, metadata.height, formatOptions);
        return { data: result.data, info: result.info, actualFormat: result.format };
    }
    
    // For AVIF images that don't need tiling
    const result = await sharpInstance
        .avif(formatOptions)
        .toBuffer({ resolveWithObject: true });
    return { data: result.data, info: result.info, actualFormat: 'avif' };
}


/**
 * Compress an image based on request parameters.
 * @param {Request} req - Express request object.
 * @param {Response} res - Express response object.
 * @param {Buffer|string} input - Input image buffer or file path.
 */
async function compress(req, res, input) {
    try {
        if (!Buffer.isBuffer(input) && typeof input !== 'string') {
            logError('Invalid input: must be a Buffer or file path.');
            return redirect(req, res);
        }

        const { format, compressionQuality, grayscale } = getCompressionParams(req);

        // Use a single sharp instance to avoid redundant metadata reads
        const sharpInstance = sharp(input, { animated: true }); // Enable animated support upfront
        const metadata = await sharpInstance.metadata();

        if (!isValidMetadata(metadata)) {
            logError('Invalid or missing metadata.');
            return redirect(req, res);
        }

        const isAnimated = metadata.pages > 1;
        const pixelCount = metadata.width * metadata.height;
        const outputFormat = isAnimated ? 'webp' : format;
        const avifParams = outputFormat === 'avif' ? optimizeAvifParams(metadata.width, metadata.height) : {};

        // Apply transformations in a pipeline to minimize intermediate buffers
        const processedImage = prepareImage(sharpInstance, grayscale, isAnimated, metadata, pixelCount);

        // Use the new compressImage function with tiling support
        const { data, info, actualFormat } = await compressImage(processedImage, metadata, outputFormat, getFormatOptions(outputFormat, compressionQuality, avifParams, isAnimated), isAnimated);

        sendImage(res, data, actualFormat || outputFormat, req.params.url || '', req.params.originSize || 0, info.size);
    } catch (err) {
        logError('Error during image compression:', err);
        redirect(req, res);
    }
}

function getCompressionParams(req) {
    const format = req.params?.webp ? 'webp' : req.params?.jpeg ? 'jpeg' : 'avif';
    const compressionQuality = Math.min(Math.max(parseInt(req.params?.quality, 10) || 75, 10), 100);
    const grayscale = req.params?.grayscale === 'true' || req.params?.grayscale === true;
    return { format, compressionQuality, grayscale };
}

function isValidMetadata(metadata) {
    return metadata && metadata.width && metadata.height;
}

function optimizeAvifParams(width, height) {
    const area = width * height;
    if (area > LARGE_IMAGE_THRESHOLD) {
        return { tileRows: 4, tileCols: 4, minQuantizer: 28, maxQuantizer: 48, effort: 3 };
    } else if (area > MEDIUM_IMAGE_THRESHOLD) {
        return { tileRows: 2, tileCols: 2, minQuantizer: 26, maxQuantizer: 46, effort: 4 };
    } else {
        return { tileRows: 1, tileCols: 1, minQuantizer: 24, maxQuantizer: 44, effort: 5 };
    }
}

function getFormatOptions(outputFormat, quality, avifParams, isAnimated) {
    const options = {
        quality,
        alphaQuality: 80,
        chromaSubsampling: '4:2:0',
        loop: isAnimated ? 0 : undefined,
    };
    return outputFormat === 'avif' ? { ...options, ...avifParams } : options;
}

function prepareImage(sharpInstance, grayscale, isAnimated, metadata, pixelCount) {
    let processedImage = sharpInstance.clone(); // Clone to avoid mutating the original instance

    if (grayscale) {
        processedImage = processedImage.grayscale();
    }

   /* if (!isAnimated) {
        processedImage = applyArtifactReduction(processedImage, pixelCount);
    } */

    return processedImage;
}

function applyArtifactReduction(sharpInstance, pixelCount) {
    const settings = pixelCount > LARGE_IMAGE_THRESHOLD
        ? { blur: 0.5, sharpen: 0.7, saturation: 0.8 }
        : pixelCount > MEDIUM_IMAGE_THRESHOLD
        ? { blur: 0.4, sharpen: 0.6, saturation: 0.85 }
        : { blur: 0.3, sharpen: 0.5, saturation: 0.9 };

    return sharpInstance
        .modulate({ saturation: settings.saturation })
        .blur(settings.blur)
        .sharpen(settings.sharpen);
}

function handleSharpError(error, res, sharpInstance, outputFormat, req, quality) {
    logError('Unhandled sharp error:', error);
    redirect(req, res);
}

function sendImage(res, data, format, url, originSize, compressedSize) {
    const filename = sanitizeFilename(new URL(url).pathname.split('/').pop() || 'image') + `.${format}`;
    res.setHeader('Content-Type', `image/${format}`);
    res.setHeader('Content-Length', data.length);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('x-original-size', originSize);
    res.setHeader('x-bytes-saved', Math.max(originSize - compressedSize, 0));
    res.status(200).end(data);
}

function logError(message, error = null) {
    console.error({ message, error: error?.message || null });
}

export default compress;
