import WebSocket from 'ws';

async function main() {
    const listResp = await fetch('http://localhost:9223/json/list');
    const pages = await listResp.json();
    const robotPage = pages.find(p => p.url && p.url.includes('/robot'));
    if (!robotPage) {
        console.error('No robot page found!');
        process.exit(1);
    }
    
    const wsUrl = robotPage.webSocketDebuggerUrl.replace('127.0.0.1:9222', 'localhost:9223');
    console.log('Connecting to', wsUrl);
    
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
        ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
                expression: `JSON.stringify({
                    innerDivFont: document.querySelector('#root > div') ? window.getComputedStyle(document.querySelector('#root > div')).fontFamily : 'no inner div',
                    innerDivBg: document.querySelector('#root > div') ? window.getComputedStyle(document.querySelector('#root > div')).backgroundColor : 'no inner div',
                    headerBg: document.querySelector('header') ? window.getComputedStyle(document.querySelector('header')).backgroundColor : 'no header',
                    headerBorder: document.querySelector('header') ? window.getComputedStyle(document.querySelector('header')).borderBottomColor : 'no header',
                    btnCatColor: document.querySelector('main button') ? window.getComputedStyle(document.querySelector('main button')).color : 'no button',
                    btnCatBg: document.querySelector('main button') ? window.getComputedStyle(document.querySelector('main button')).backgroundColor : 'no button',
                })`
            }
        }));
    });
    
    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1) {
            console.log('Inner div computed values:', msg.result?.result?.value);
            ws.close();
            process.exit(0);
        }
    });
}

main().catch(console.error);
