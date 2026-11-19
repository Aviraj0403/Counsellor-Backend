// pm2 process file (same convention as central-ecommerce). ".cjs" because this package is ESM ("type": "module").
module.exports = {
  apps: [
    {
      name: 'counsellor-platform-api',
      script: 'dist/src/app/server.js',
      instances: 1,
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '500M',
      kill_timeout: 15000, // must exceed the 10 s graceful-shutdown timer in src/app/server.ts
      env_production: { NODE_ENV: 'production', PORT: 1010 },
      env_development: { NODE_ENV: 'development', PORT: 1010 },
      error_file: 'logs/err.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
