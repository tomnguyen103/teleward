import { render } from 'preact';
import './index.css';
import { App } from './App.tsx';

const mountEl = document.getElementById('app');
if (mountEl) {
  render(<App />, mountEl);
}
