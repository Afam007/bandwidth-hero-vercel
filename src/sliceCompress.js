import sharp from 'sharp';
import gm from 'gm';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const MAX_DIMENSION = 16382;

/**
 * Joins image slices using ImageMagick (gm).
 * @param {string[]} slicePaths - Array of file paths to image slices.
 * @param {string} direction - 'vertical' or 'horizontal'
 * @returns {Promise<Buffer>} - Buffer of the final joined image.
 */
async function joinSlicesWithImageMagick(slicePaths, direction = 'vertical') {
    return new Promise((resolve, reject) => {
        let img = gm();
        slicePaths.forEach((slice) => {
            img = img.in(slice);
        });
        // direction: true for vertical, false for horizontal
        img.append(direction === 'vertical').toBuffer('webp', function(err, buffer) {
            if (err) return reject(err);
            resolve(buffer);
        });
    });
}

/**
 * Slice an image vertically or horizontally if it exceeds MAX_DIMENSION,
 * compress each slice to webp, and reassemble into the original layout using ImageMagick.
 *
 * @param {Buffer} inputBuffer - The image buffer.
 * @param {Object} formatOpts - Options (supports { quality }).
 * @returns {Promise<Buffer>} - The reassembled webp buffer.
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
            .toBuffer();
    }

    // Prepare temp folder for slices
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bh-slices-'));
    const slicePaths = [];

    // Extract, compress, and store each slice to disk
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
            .toFormat('webp', formatOpts)
            .toBuffer();
        const slicePath = path.join(tempDir, `slice${i}.webp`);
        await fs.writeFile(slicePath, sliceBuffer);
        slicePaths.push(slicePath);
    }

    // Join slices using ImageMagick (gm)
    const joinedBuffer = await joinSlicesWithImageMagick(slicePaths, direction);

    // Cleanup temp files
    await Promise.all(slicePaths.map((p) => fs.unlink(p)));
    await fs.rmdir(tempDir);

    return joinedBuffer;
}
