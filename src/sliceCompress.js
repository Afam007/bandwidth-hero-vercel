import sharp from 'sharp';
import gm from 'gm';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const MAX_DIMENSION = 16382;
const WEBP_MAX_DIMENSION = 16383; // WebP's actual limit

/**
 * Joins image slices using ImageMagick command line.
 * Uses PNG as intermediate format to avoid WebP dimension limits.
 * @param {string[]} slicePaths - Array of file paths to image slices.
 * @param {boolean} useHorizontalAppend - true for horizontal append, false for vertical append
 * @returns {Promise<Buffer>} - Buffer of the final joined PNG image.
 */
async function joinSlicesWithImageMagick(slicePaths, useHorizontalAppend = true) {
    // Verify all files exist
    for (const slicePath of slicePaths) {
        try {
            await fs.stat(slicePath);
        } catch (err) {
            throw new Error(`Slice file not found: ${slicePath}`);
        }
    }
    
    // Create output path
    const tempDir = path.dirname(slicePaths[0]);
    const outputPath = path.join(tempDir, 'joined.png');
    
    // Build ImageMagick command - use PNG output to avoid WebP dimension limits
    const appendOp = useHorizontalAppend ? '+append' : '-append';
    const quotedPaths = slicePaths.map(p => `"${p}"`).join(' ');
    const command = `convert ${quotedPaths} ${appendOp} "${outputPath}"`;
    
    try {
        const { stdout, stderr } = await execAsync(command);
        
        const joinedBuffer = await fs.readFile(outputPath);
        
        // Clean up the intermediate file
        await fs.unlink(outputPath);
        
        return joinedBuffer;
    } catch (error) {
        throw new Error(`ImageMagick join failed: ${error.message}`);
    }
}

/**
 * Slice an image vertically or horizontally if it exceeds MAX_DIMENSION,
 * compress each slice to webp, and reassemble into the original layout using ImageMagick.
 *
 * @param {Buffer} inputBuffer - The image buffer.
 * @param {Object} formatOpts - Options (supports { quality }).
 * @returns {Promise<Object>} - Object with data (reassembled webp buffer) and info (size).
 */
export async function sliceCompress(inputBuffer, formatOpts) {
    const meta = await sharp(inputBuffer, { animated: true }).metadata();

    // Determine if slicing is needed
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
            .toBuffer({ resolveWithObject: true });
    }

    // Prepare temp folder for slices
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bh-slices-'));
    const slicePaths = [];

    try {
        // Extract, compress, and store each slice to disk as PNG
        // Use PNG for slices to avoid any WebP limitations during processing
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
            
            const sliceBuffer = await sharp(inputBuffer)
                .extract(extractOpts)
                .png() // Use PNG for intermediate files
                .toBuffer();
            const slicePath = path.join(tempDir, `slice${i}.png`);
            await fs.writeFile(slicePath, sliceBuffer);
            slicePaths.push(slicePath);
        }

        // Join slices using ImageMagick command line
        // For vertical slicing (wide images), we need horizontal append
        // For horizontal slicing (tall images), we need vertical append  
        const useHorizontalAppend = direction === 'vertical';
        const joinedPngBuffer = await joinSlicesWithImageMagick(slicePaths, useHorizontalAppend);

        // Convert the joined PNG to WebP using Sharp
        // Check if the result dimensions exceed WebP limits
        const joinedMeta = await sharp(joinedPngBuffer).metadata();
        
        let finalWebpBuffer;
        
        if (joinedMeta.width > WEBP_MAX_DIMENSION || joinedMeta.height > WEBP_MAX_DIMENSION) {
            // Scale down to fit WebP limits while preserving aspect ratio
            const scaleRatio = Math.min(
                WEBP_MAX_DIMENSION / joinedMeta.width,
                WEBP_MAX_DIMENSION / joinedMeta.height
            );
            const newWidth = Math.floor(joinedMeta.width * scaleRatio);
            const newHeight = Math.floor(joinedMeta.height * scaleRatio);
            
            finalWebpBuffer = await sharp(joinedPngBuffer)
                .resize(newWidth, newHeight)
                .webp(formatOpts)
                .toBuffer();
        } else {
            // Direct conversion to WebP
            finalWebpBuffer = await sharp(joinedPngBuffer)
                .webp(formatOpts)
                .toBuffer();
        }

        return {
            data: finalWebpBuffer,
            info: { size: finalWebpBuffer.length }
        };
    } finally {
        // Cleanup temp files
        await Promise.all(slicePaths.map(async (p) => {
            try {
                await fs.unlink(p);
            } catch (err) {
                console.warn('Failed to delete temp file:', p, err.message);
            }
        }));
        try {
            await fs.rmdir(tempDir);
        } catch (err) {
            console.warn('Failed to delete temp directory:', tempDir, err.message);
        }
    }
}
