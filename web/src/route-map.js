import { mount } from 'svelte';
import './styles.css';
import RouteMap from './maps/RouteMap.svelte';

export default mount(RouteMap, { target: document.body });
