import fs from 'fs';
import path from 'path';
import postcss from 'postcss';
import postcssCascadeLayers from '@csstools/postcss-cascade-layers';

const assetsDir = path.resolve('dist/assets');

async function processFile(filePath) {
    console.log('Processing:', filePath);
    const css = fs.readFileSync(filePath, 'utf8');
    
    try {
        const result = await postcss([postcssCascadeLayers()]).process(css, { from: filePath, to: filePath });
        fs.writeFileSync(filePath, result.css, 'utf8');
        console.log('Successfully processed:', filePath);
    } catch (err) {
        console.error('Error processing:', filePath, err);
    }
}

async function main() {
    if (!fs.existsSync(assetsDir)) {
        console.error('Assets directory does not exist:', assetsDir);
        return;
    }
    
    const files = fs.readdirSync(assetsDir);
    for (const file of files) {
        if (file.endsWith('.css')) {
            await processFile(path.join(assetsDir, file));
        }
    }
}

main();
