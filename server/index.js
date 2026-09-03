require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { migrate } = require('./db');
const wsHub = require('./ws');
const sheetsRouter = require('./routes/sheets');
const nodesRouter = require('./routes/nodes');
const annotationsRouter = require('./routes/annotations');
const exportRouter = require('./routes/exportGoogleSheets');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api', sheetsRouter);
app.use('/api', nodesRouter);
app.use('/api', annotationsRouter);
app.use('/api', exportRouter);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const server = http.createServer(app);
wsHub.attach(server);

const port = process.env.PORT || 3000;

migrate()
  .then(() => {
    server.listen(port, () => console.log('Listening on port ' + port));
  })
  .catch((err) => {
    console.error('Migration failed', err);
    process.exit(1);
  });
