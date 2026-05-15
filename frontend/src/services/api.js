import axios from 'axios';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export async function fetchSignals() {
  const response = await axios.get(`${BACKEND_URL}/api/signals`);
  return response.data;
}
