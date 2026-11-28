import { mount } from 'svelte';
import App from './App.svelte';
import '@/assets/ui.css';
import './pdf.css';

export default mount(App, { target: document.getElementById('app')! });
