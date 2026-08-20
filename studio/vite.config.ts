import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target: 'https://localhost:4433', ws: true, secure: false },
      '/api': { target: 'https://localhost:4433', secure: false },
      '/sessions': { target: 'https://localhost:4433', secure: false },
    },
  },
});
