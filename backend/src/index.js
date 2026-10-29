import './env.js';
import app from './app.js';

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend rodando em http://0.0.0.0:${PORT}`);
});
