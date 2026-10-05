import { mount } from 'svelte';
import './styles.css';
import Login from './login/Login.svelte';

export default mount(Login, { target: document.getElementById('app') });
