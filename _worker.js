function getHomePageHTML(){
    return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>docker.jjaw.cn start</title>
    <style>
        :root {
            font-size: min(16px, 3vmin);
        }
        html,
        body {
            border: 0;
            padding: 0;
            margin: 0;
            width: 100%;
            height: 100%;
        }
        .commline{
            color: rgb(255, 255, 255);
            font-size: 1.3rem;
            background-color: rgb(37, 37, 37);
            border-radius: 0.5rem;
            padding: 0.5rem 1rem;
            display: flex;
            margin-bottom: 1rem;
            width: 30rem;
        }
        .uptext{
            font-size: 1rem;
            margin: 1rem 0 0.5rem 0;
        }
    </style>
</head>
<body>
    <div style="
        display: flex;
        width: 100%;
        min-height: 100%;
        align-items: center;
        justify-content: center;
        flex-direction: column;
    ">
        <h2 style="font-size: 2rem;margin-bottom: 3rem;">开始你的docker快速pull之旅</h2>
        <p class="uptext">使用vim编辑docker镜像源</p>
        <div class="commline">
            <pre style="margin: 0;">sudo vim /etc/docker/daemon.json</pre>
        </div>
        <p class="uptext">添加 https://docker.jjaw.cn</p>
        <div class="commline">
            <pre style="margin: 0;">{
    "registry-mirrors": [
        "https://docker.jjaw.cn"
    ]
}</pre>
        </div>
        <p class="uptext">重启docker</p>
        <div class="commline">
            <pre style="margin: 0;">sudo systemctl daemon-reload
sudo systemctl restart docker</pre>
        </div>
</body>
</html>`
}

export default {
    async fetch(request, env, ctx) {
        ctx.passThroughOnException();
        const url = new URL(request.url);
        if (url.pathname == "/") {
            return new Response(getHomePageHTML(url.hostname), {
                headers: {
                    "content-type": "text/html;charset=utf-8"
                }
            });
        }
        return handleRequest(request)
    }
}

//环境变量??????
const MODE = "production";

// 配置参考
// https://github.com/ciiiii/cloudflare-docker-proxy
const dockerHub = "https://registry-1.docker.io";

const routes = {
    // production
    "docker.jjaw.cn": dockerHub,
    // "quay.jjaw.cn": "https://quay.io",
    // "gcr.jjaw.cn": "https://gcr.io",
    // "k8s-gcr.jjaw.cn": "https://k8s.gcr.io",
    // "k8s.jjaw.cn": "https://registry.k8s.io",
    // "ghcr.jjaw.cn": "https://ghcr.io",
    // "cloudsmith.jjaw.cn": "https://docker.cloudsmith.io",
    // "ecr.jjaw.cn": "https://public.ecr.aws",
};

function routeByHosts(host) {
    if (host in routes) {
        return routes[host];
    }
    if (MODE == "debug") {
        return TARGET_UPSTREAM;
    }
    return "";
}

async function handleRequest(request) {
    const url = new URL(request.url);
    const upstream = routeByHosts(url.hostname);
    if (upstream === "") {
        return new Response(
            JSON.stringify({
                routes: routes,
            }),
            {
                status: 404,
            }
        );
    }
    const isDockerHub = upstream == dockerHub;
    const authorization = request.headers.get("Authorization");
    if (url.pathname == "/v2/") {
        const newUrl = new URL(upstream + "/v2/");
        const headers = new Headers();
        if (authorization) {
            headers.set("Authorization", authorization);
        }
        // check if need to authenticate
        const resp = await fetch(newUrl.toString(), {
            method: "GET",
            headers: headers,
            redirect: "follow",
        });
        if (resp.status === 401) {
            if (MODE == "debug") {
                headers.set(
                    "Www-Authenticate",
                    `Bearer realm="http://${url.host}/v2/auth",service="cloudflare-docker-proxy"`
                );
            } else {
                headers.set(
                    "Www-Authenticate",
                    `Bearer realm="https://${url.hostname}/v2/auth",service="cloudflare-docker-proxy"`
                );
            }
            return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
                status: 401,
                headers: headers,
            });
        } else {
            return resp;
        }
    }
    // get token
    if (url.pathname == "/v2/auth") {
        const newUrl = new URL(upstream + "/v2/");
        const resp = await fetch(newUrl.toString(), {
            method: "GET",
            redirect: "follow",
        });
        if (resp.status !== 401) {
            return resp;
        }
        const authenticateStr = resp.headers.get("WWW-Authenticate");
        if (authenticateStr === null) {
            return resp;
        }
        const wwwAuthenticate = parseAuthenticate(authenticateStr);
        let scope = url.searchParams.get("scope");
        // autocomplete repo part into scope for DockerHub library images
        // Example: repository:busybox:pull => repository:library/busybox:pull
        if (scope && isDockerHub) {
            let scopeParts = scope.split(":");
            if (scopeParts.length == 3 && !scopeParts[1].includes("/")) {
                scopeParts[1] = "library/" + scopeParts[1];
                scope = scopeParts.join(":");
            }
        }
        return await fetchToken(wwwAuthenticate, scope, authorization);
    }
    // redirect for DockerHub library images
    // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
    if (isDockerHub) {
        const pathParts = url.pathname.split("/");
        if (pathParts.length == 5) {
            pathParts.splice(2, 0, "library");
            const redirectUrl = new URL(url);
            redirectUrl.pathname = pathParts.join("/");
            return Response.redirect(redirectUrl, 301);
        }
    }
    // foward requests
    const newUrl = new URL(upstream + url.pathname);
    const newReq = new Request(newUrl, {
        method: request.method,
        headers: request.headers,
        redirect: "follow",
    });
    return await fetch(newReq);
}

function parseAuthenticate(authenticateStr) {
    // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
    // match strings after =" and before "
    const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
    const matches = authenticateStr.match(re);
    if (matches == null || matches.length < 2) {
        throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
    }
    return {
        realm: matches[0],
        service: matches[1],
    };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
    const url = new URL(wwwAuthenticate.realm);
    if (wwwAuthenticate.service.length) {
        url.searchParams.set("service", wwwAuthenticate.service);
    }
    if (scope) {
        url.searchParams.set("scope", scope);
    }
    headers = new Headers();
    if (authorization) {
        headers.set("Authorization", authorization);
    }
    return await fetch(url, { method: "GET", headers: headers });
}