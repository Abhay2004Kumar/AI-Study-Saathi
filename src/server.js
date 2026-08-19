const app = require('./app');
const config = require('./config/env');

const server = app.listen(config.port, () => {
  console.log(`Server is running in ${config.env} mode on port ${config.port}`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.log(`Error: ${err.message}`);
  // Close server & exit process
  server.close(() => process.exit(1));
});
