rm replay.zip
rm -rf ./bundle/
set -e
mkdir ./bundle/
cp -r ./lib/ ./bundle/lib/
cp package.json bundle/package.json
cp package-lock.json bundle/package-lock.json
cp "$(which node)" bundle/

pushd bundle/
npm cache clean --force
npm ci --production
rm -r node_modules/puppeteer/.local-chromium
popd
