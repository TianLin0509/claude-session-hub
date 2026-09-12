'use strict';
require('../core/chatgpt-web-integration').openWebSettings().then(() => console.log('ChatGPT 专用隔离启动器已打开')).catch(error => { console.error(error.message); process.exitCode = 1; });
