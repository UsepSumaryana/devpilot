console.log('crasher starting');
setTimeout(() => { throw new Error('Database connection lost: ECONNREFUSED 127.0.0.1:5999'); }, 800);
