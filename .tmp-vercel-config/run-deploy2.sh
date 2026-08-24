#!/bin/bash
export HOME=/home/lenovo/Desktop/image-app/.tmp-home
export XDG_CACHE_HOME=$HOME/.cache
export VERCEL_UPDATE_CHECK=0
cd /home/lenovo/Desktop/image-app
echo '=== DEPLOY START ==='
npx vercel deploy --prod --yes
echo '=== DEPLOY EXIT $? ==='
