#!/usr/bin/env bash

function get_release_id() {
    i=0
    while [ $i -lt 3 ]
    do
        RELEASE_ID=$(curl -s -H "Authorization: token $1" \
            https://api.github.com/repos/$2/releases | \
            jq ".[] | select(.tag_name == \"$3\") | .id")
        if [ -z "$RELEASE_ID" ]; then
            i=`expr $i + 1`
            sleep 5
        else
            echo $RELEASE_ID
            return 0
        fi
    done
    return 1
}
