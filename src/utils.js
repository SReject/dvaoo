// uuid v4.112
exports.uuid = () => {
    let uid = 'rrrrrrrr-rrrr-4rrr-Mrrr-rrrrrrrrrrrr'.split('');
    for (let i = 0; i < 36; i += 1) {
        const rand = Math.floor(Math.random() * 16);
        if (uid[i] === 'r') {
            uid[i] = rand.toString(16);
        } else if (uid[i] === 'M') {
            uid[i] = (rand & 3).toString(16);
        } 
    }
    return uid.join('');
}