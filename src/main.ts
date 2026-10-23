import './styles.css';
import { Hmi } from './ui/hmi';

const hmi = new Hmi();
if (import.meta.env.DEV) (window as unknown as { hmi: Hmi }).hmi = hmi; // console access while developing
