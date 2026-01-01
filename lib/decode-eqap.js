'use strict';

const { EdupageHttp } = require('./lib/edupageHttp');

// dummy http reicht, wir decodieren nur lokal
const eh = new EdupageHttp({ http: null, log: console });

const eqap = `dz:RZLNkqIwFIWfhuVMkRAEFrMAMQja2o0iP7sQIiC/gij49B3bLmZzkzr5ONw693YtbUlHqv6foBgChEPPuppUjF8FSef1TKq8zJmAxJjRgj1Y/Df5eYVLXlvS94+mS2ZcgBJr+xs/xhl6eR6bgtUzRSHuE/O6FoNwJ0Aj9Z2DE6jGIs83z8PFTgKvrvaTAPHaWq53oR1cimIJcolUWW2U9XBWK9M9PbZD4ymNYk/pp2aLLeB9GdO+OX4sAC3w/qLLzFiil5jhTNSeZ5KYu8HBRs6e45ev3KdYdWwIUBOwamVFyUeaTWuUmSDcfsB7pBRMDuJdvYkm+7Q9kXzzmT4iO/vUiya5Ix27pe0tQva42SlaHTAgRyDWkxGu/PvAqKpLdNzoF7UMfdm6wnbSFG888XB40kaXNNIypy4RXR4VpnZwujtcZ6W1e2JSFsdOvTpw7GmtVKO32noHdIBH8LVv3UdUQtc8rmrJdyyDZFEXyuGCeU+VO5nTYrxpQ6vUkUP96wHPg2DJ0JL0/2y7/k/RlGVNhhmht5H3Nw/zV739AJJeD2X5VtJf5QfBCemzuCGvPcB8QdqsFSTMrkSQzNjXiojHQnxQJhbOY8sToCyZs/f75+9d02QERQmpcaIRmRIZnlEMZADiBULaWZRjRT0DJL8+UMxv`;

const decoded = eh.decodeEqapToQuerystring(eqap);

console.log('--- DECODED EQAP ---');
console.log(decoded);
