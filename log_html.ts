import axios from 'axios';

async function logHTML() {
  const url = "https://wuk.168y.cloudns.org/";
  try {
    const res = await axios.get(url);
    console.log(res.data.substring(1200, 2000));
  } catch(e) {}
}
logHTML();
