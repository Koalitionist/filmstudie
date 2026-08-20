import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// No StrictMode: double-mounted effects would double-open cameras/sockets,
// and iOS mutes the first getUserMedia stream when a second one opens.
createRoot(document.getElementById('root')!).render(<App />);
