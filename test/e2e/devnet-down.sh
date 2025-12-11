lsof -ti:8545 | xargs kill -9 2>/dev/null
lsof -ti:8546 | xargs kill -9 2>/dev/null
rm -f mainnet.log arbitrum.log
echo 'Devnets stopped and logs cleaned'