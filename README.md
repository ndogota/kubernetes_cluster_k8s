# Three-Tier App on a Multi-Node Kubernetes Cluster (kubeadm)

A documented deployment of a three-tier web application (React front end, Node/Express
API, MongoDB) on a self-managed, multi-node Kubernetes cluster built with `kubeadm`.
The cluster runs one control-plane node and two worker nodes, pulls images from a
self-hosted private container registry, exposes the front end through an Ingress, and
includes a minimal RBAC binding. Each tier ships as its own container image with its own
Deployment and Service.

This repository is the infrastructure and manifests. It is meant to be read as a
reference for bootstrapping a small bare-metal/VM cluster and deploying a containerized
app onto it, not as a production-hardened template. See
[What this demonstrates](#what-this-demonstrates) and
[Limitations](#limitations) for the honest scope.

## Architecture

```
                       client (browser)
                              |
                              v
                    +------------------+
                    |     Ingress      |   host: k8s-master, path: /
                    +------------------+
                              |
                              v
                    +------------------+
                    |  front-service   |   ClusterIP :3000
                    +------------------+
                              |
                              v
                    +------------------+
                    |  front Deployment|   React (served by react-scripts)
                    +------------------+

      in-cluster service-to-service calls (ClusterIP DNS):

   front pod --> http://back-service:3070  --> back Deployment (Node/Express)
   back pod  --> mongodb://db-service:27017 --> db Deployment (MongoDB)

      images for all three tiers are pulled from:

                  private-registry:5000/{front,back,db}-image:latest
                  (auth via the imagePullSecret "my-registry-secret")
```

Tiers and the manifests that define them:

| Tier  | Image                                | Deployment                     | Service (ClusterIP)            | Port  |
|-------|--------------------------------------|--------------------------------|--------------------------------|-------|
| Front | `private-registry:5000/front-image`  | `front/front-deployement.yaml` | `front/front-service.yaml`     | 3000  |
| Back  | `private-registry:5000/back-image`   | `back/back-deployement.yaml`   | `back/back-service.yaml`       | 3070  |
| DB    | `private-registry:5000/db-image`     | `db/db-deployement.yaml`       | `db/db-service.yaml`           | 27017 |

The API reads/writes MongoDB at `db-service:27017` (see `back/api/index.js`) and serves
`GET /cars`. The front end fetches `http://back-service:3070/cars` (see
`front/react-docker/src/App.js`). The Ingress (`kubernetes/deploy/ingress.yaml`) routes
the cluster host to `front-service`. A `cluster-admin` RBAC binding for the dashboard
service account lives in `kubernetes/rbac.yml`.

## Repository layout

```
back/    Node/Express API: Dockerfile, source (api/), Deployment, Service
front/   React app: Dockerfile, source (react-docker/), Deployment, Service
db/      MongoDB image: Dockerfile, Deployment, Service
kubernetes/
  deploy/ingress.yaml   Ingress for the front end
  rbac.yml              ClusterRoleBinding for the dashboard service account
```

## Topology

The cluster is four nodes. Roles are generic; hostnames and IPs below are only an example
for a local VM lab (Debian 12 on aarch64 in the original build) and are not required
values.

| Role             | Example hostname  | Notes                                          |
|------------------|-------------------|------------------------------------------------|
| Control plane    | `k8s-master`      | `kubeadm init` runs here                        |
| Worker 1         | `k8s-worker01`    | joins the control plane                         |
| Worker 2         | `k8s-worker02`    | joins the control plane                         |
| Private registry | `private-registry`| Docker registry on :5000, TLS, not a k8s node   |

Example `/etc/hosts` entries used on every node so the short names resolve. Replace the
addresses with your own; they are illustrative, not fixed:

```
# example only - substitute your own addresses
192.168.64.80   k8s-master
192.168.64.81   k8s-worker01
192.168.64.82   k8s-worker02
192.168.64.76   private-registry
```

## Prerequisites

On all three Kubernetes nodes (control plane and workers):

- Disable swap and persist it:
  ```
  sudo swapoff -a
  sudo sed -i '/ swap / s/^\(.*\)$/#\1/g' /etc/fstab
  ```
- Load kernel modules and set sysctls for the container network:
  ```
  cat <<EOF | sudo tee /etc/modules-load.d/containerd.conf
  overlay
  br_netfilter
  EOF
  sudo modprobe overlay
  sudo modprobe br_netfilter

  cat <<EOF | sudo tee /etc/sysctl.d/99-kubernetes-k8s.conf
  net.bridge.bridge-nf-call-iptables  = 1
  net.bridge.bridge-nf-call-ip6tables = 1
  net.ipv4.ip_forward                 = 1
  EOF
  sudo sysctl --system
  ```
- Install and configure containerd, then set `SystemdCgroup = true` in
  `/etc/containerd/config.toml`:
  ```
  sudo apt update && sudo apt -y install containerd
  containerd config default | sudo tee /etc/containerd/config.toml >/dev/null
  sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
  sudo systemctl restart containerd && sudo systemctl enable containerd
  ```
- Install the Kubernetes tools and pin them:
  ```
  sudo apt install kubelet kubeadm kubectl -y
  sudo apt-mark hold kubelet kubeadm kubectl
  ```
- Open the required firewall ports. Control plane needs 6443, 2379-2380,
  10250-10252, 10255; workers need 10250 and the NodePort range 30000-32767.
  Keep your SSH port open before enabling the firewall.

## Cluster setup runbook

### 1. Private container registry

Run a TLS-enabled Docker registry on the `private-registry` host. Generate a self-signed
certificate whose Subject Alternative Name covers the registry hostname and IP, then start
the registry with that certificate:

```
docker run -d \
  -p 5000:5000 --restart=always --name registry \
  -v /home/user/certs:/certs \
  -e REGISTRY_HTTP_ADDR=0.0.0.0:5000 \
  -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/domain.crt \
  -e REGISTRY_HTTP_TLS_KEY=/certs/domain.key \
  registry:2
```

Distribute the registry CA certificate to every node so containerd trusts it:

```
sudo mkdir -p /etc/containerd/certs.d/private-registry:5000
sudo cp ca.crt /etc/containerd/certs.d/private-registry:5000/ca.crt
```

and reference it in `/etc/containerd/config.toml`:

```
[plugins."io.containerd.grpc.v1.cri".registry.configs."private-registry:5000".tls]
  ca_file = "/etc/containerd/certs.d/private-registry:5000/ca.crt"
```

### 2. Initialize the control plane

On the control-plane node:

```
sudo kubeadm init --control-plane-endpoint=k8s-master
```

Set up `kubectl` for your user:

```
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

### 3. Join the workers

`kubeadm init` prints a join command containing a bootstrap token and the CA cert hash.
These are per-cluster secrets. Do not copy real values into documentation or version
control. On each worker, run the join command with your own values:

```
sudo kubeadm join k8s-master:6443 \
  --token <BOOTSTRAP_TOKEN> \
  --discovery-token-ca-cert-hash sha256:<CA_CERT_HASH>
```

Bootstrap tokens are generated per cluster and expire (24h by default). If you need a
fresh one, generate it on the control plane with `kubeadm token create` and recover the
CA hash with:

```
openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt \
  | openssl rsa -pubin -outform der 2>/dev/null \
  | openssl dgst -sha256 -hex | sed 's/^.* //'
```

### 4. Install a CNI

Pods cannot communicate until a CNI is installed. This cluster used Calico:

```
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.26.1/manifests/calico.yaml
```

Confirm all nodes report `Ready`:

```
kubectl get nodes
```

## Application deployment

### 1. Build and push the images

From each tier's directory, build the image and push it to the private registry. The
image names must match what the manifests expect
(`private-registry:5000/{front,back,db}-image:latest`):

```
# db
docker build -t private-registry:5000/db-image:latest db/
# back
docker build -t private-registry:5000/back-image:latest back/
# front
docker build -t private-registry:5000/front-image:latest front/

docker push private-registry:5000/db-image:latest
docker push private-registry:5000/back-image:latest
docker push private-registry:5000/front-image:latest
```

### 2. Create the image pull secret

The Deployments reference an `imagePullSecret` named `my-registry-secret`. Create it
out-of-band so registry credentials never live in the repository:

```
kubectl create secret docker-registry my-registry-secret \
  --docker-server=private-registry:5000 \
  --docker-username=<REGISTRY_USER> \
  --docker-password=<REGISTRY_PASSWORD>
```

### 3. Apply the manifests

```
kubectl apply -f db/db-deployement.yaml -f db/db-service.yaml
kubectl apply -f back/back-deployement.yaml -f back/back-service.yaml
kubectl apply -f front/front-deployement.yaml -f front/front-service.yaml
kubectl apply -f kubernetes/deploy/ingress.yaml
kubectl apply -f kubernetes/rbac.yml
```

Validate manifests before applying with a client-side dry run (needs a reachable API
server):

```
kubectl apply --dry-run=client -f <file>
```

### 4. Access the app

With an Ingress controller installed, the front end is reachable at the Ingress host
(`http://k8s-master/`). The API serves `GET /cars`; the front end calls it in-cluster at
`back-service:3070`.

## What this demonstrates

- Bootstrapping a multi-node Kubernetes cluster from scratch with `kubeadm` (control
  plane init, worker join, CNI install).
- Running and trusting a self-hosted private container registry over TLS, including
  configuring containerd to pull from it.
- Packaging and deploying a three-tier application as independent Deployments and
  Services, with in-cluster service discovery between tiers.
- Exposing a service externally through an Ingress.
- A minimal RBAC binding for the Kubernetes dashboard service account.

## Limitations

This is a demo-grade lab, not a hardened production setup. Known gaps, kept honest on
purpose:

- **Security is demo-grade.** MongoDB runs with no authentication and
  `mongod --bind_ip 0.0.0.0`, which accepts connections from anywhere on the pod network.
  For anything beyond a throwaway demo, enable auth, bind to specific interfaces, and put
  credentials in a Kubernetes Secret.
- **No TLS on app traffic.** The Ingress serves plain HTTP. There is no cert-manager or
  TLS termination for the app itself (the registry uses TLS, the app does not).
- **The `cluster-admin` RBAC binding is broad.** `kubernetes/rbac.yml` grants
  `cluster-admin` to the dashboard service account. That is convenient for a lab and
  over-privileged for real use.
- **Front-end to API call assumes in-cluster DNS.** `App.js` calls
  `http://back-service:3070/cars`, which resolves inside the cluster but not from a
  browser on a separate machine. A browser-facing deployment needs the API exposed through
  the Ingress (or a public URL) and the front end pointed at it. This is left as-is to
  reflect the original lab.
- **Single replica, local storage.** Replica counts are 1 and persistence (when used)
  relies on `hostPath`/local PVs, which do not survive node loss.
- **Dated front end.** The React app is a minimal Create React App scaffold used to prove
  the data path end to end, not a polished UI.
