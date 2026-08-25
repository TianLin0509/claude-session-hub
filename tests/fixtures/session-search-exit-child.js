'use strict';

process.on('message', message => {
  if (!message || message.type === 'init') return;
  process.stderr.write('intentional isolated search child exit\n');
  process.exit(86);
});
