rm replay.zip
rm -rf ./bundle/
set -e
mkdir ./bundle/
cp -r ./lib/ ./bundle/lib/
cp -r node_modules/ ./bundle/node_modules/
cp package.json bundle/package.json
cp package-lock.json bundle/package-lock.json
cp "$(which node)" bundle/
rm -r bundle/node_modules/puppeteer/.local-chromium
