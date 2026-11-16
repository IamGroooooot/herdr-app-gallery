import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execWith } from './helpers.js';

export const host = { home: '', appHome: '', programs: {}, shared: new Map(), notices: [], sounds: [] };

const real = execWith();
export const exec = (command, args = [], options = {}) =>
  command in host.programs ? Promise.resolve().then(() => host.programs[command](args)) : real(command, args, options);
export const hc = async () => ({ code: 1, stdout: '', stderr: '' });
export const home = () => host.home;
export const appHome = () => host.appHome;
export const readTextFile = async path => (existsSync(path) ? readFileSync(path, 'utf8') : null);
export async function writeTextFile(path, text, before) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (before !== undefined && current !== before) throw new Error(`${path} changed outside Herdr`);
  writeFileSync(path, text);
}
export const shared = key => host.shared.get(key) ?? null;
export const setShared = (key, value) => {
  host.shared.set(key, value);
};
export const notify = notice => {
  host.notices.push(notice);
};
export const playSound = name => {
  host.sounds.push(name);
};
