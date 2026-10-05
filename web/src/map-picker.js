import { mount } from 'svelte';
import './styles.css';
import MapPicker from './maps/MapPicker.svelte';

export default mount(MapPicker, { target: document.body });
