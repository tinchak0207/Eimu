#!/bin/bash
export HOME=/home/lenovo/Desktop/image-app/.tmp-home
export XDG_CACHE_HOME=$HOME/.cache
export VERCEL_UPDATE_CHECK=0
mkdir -p $HOME/.local/share/com.vercel.cli
printf '{"currentTeam":"team_tOdYoQMCy690bxXnXJZErAgm","telemetry":{"enabled":false}}' > $HOME/.local/share/com.vercel.cli/config.json
echo '=== LOGIN START ==='
npx vercel login
echo '=== LOGIN EXIT $? ==='
if [ -f $HOME/.local/share/com.vercel.cli/auth.json ]; then
  echo '=== DEPLOY START ==='
  cd /home/lenovo/Desktop/image-app && npx vercel deploy --prod --yes
  echo '=== DEPLOY EXIT $? ==='
else
  echo 'NO_AUTH_FILE login did not persist'
fi
