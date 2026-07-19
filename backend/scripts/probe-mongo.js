const mongoose = require('mongoose');

const u = process.env.MONGODB_URI || '';
console.log('prefix:', u.slice(0, 30));
console.log('is_srv:', u.startsWith('mongodb+srv://'));
console.log('has_db:', /\/kachingscanner(\?|$)/.test(u));
console.log('len:', u.length);

mongoose
  .connect(u, { serverSelectionTimeoutMS: 10000 })
  .then(() => {
    console.log('connect: OK state=', mongoose.connection.readyState);
    process.exit(0);
  })
  .catch((err) => {
    console.log('connect: FAIL');
    console.log(err.message);
    process.exit(1);
  });
