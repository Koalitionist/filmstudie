import Camera from './pages/Camera';
import Edit from './pages/Edit';
import Producer from './pages/Producer';

export default function App() {
  const path = window.location.pathname;
  if (path.startsWith('/camera')) return <Camera />;
  if (path.startsWith('/edit')) return <Edit />;
  return <Producer />;
}
