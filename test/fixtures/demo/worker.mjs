console.log('worker booting...');
setTimeout(() => console.log('worker ready to process jobs'), 2000);
setInterval(() => console.log('tick', new Date().toISOString()), 5000);
