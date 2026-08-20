import { execFileSync } from 'node:child_process';
import os from 'node:os';

// Bonjour name (<name>.local) is what iOS Safari will trust the cert for;
// bare LAN IPs break WSS on iOS even with an installed CA.
export function bonjourHost() {
  try {
    const name = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
    if (name) return `${name}.local`;
  } catch {
    // not macOS or scutil unavailable
  }
  const h = os.hostname();
  return h.endsWith('.local') ? h : `${h}.local`;
}

export function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
