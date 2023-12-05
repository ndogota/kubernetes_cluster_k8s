Dans le cadre d'un projet, nous avons eu besoin d'implémenter un cluster Kubernetes.

Nous allons vous détailler la marche à suivre pour l'implémentation.

Prérequis :
-----------

Pour cela nous allons utiliser 4 machines virtuelles, a savoir :

```text-plain
192.168.64.80 	k8s-master.vm1.local            k8s-master
192.168.64.81 	k8s-worker01.vm2.local          k8s-worker01
192.168.64.82   k8s-worker02.vm3.local          k8s-worker02
192.168.64.76   private-registry.vm4.local      private-registry
```

Chacune de ces machines virtuelles tourne sur Debian 12.2.0 sur l'architecture aarch64.


Création d’images Docker pour développer une application Web
-----------------------------------------------------------------------

Nous allons utiliser la vm4 (private-registry.vm4.local) pour la création des images docker que nous utiliserons dans ce projet, il sera plus propre par la suite d'y installer le docker registry dessus pour ne pas mélanger les installations avec les autres machines virtuelles.

Connecter vous en ssh sur la machine vm4 :

```text-plain
ssh user@private-registry
```

### installation de docker

Désinstallation de tout les packages qui pourrait rentrer en conflit avec l'installation de docker :

```text-plain
for pkg in docker.io docker-doc docker-compose podman-docker containerd runc; do sudo apt-get remove $pkg; done
```

Ajouter les repos :

```text-plain
# Add Docker's official GPG key:
sudo apt-get update
sudo apt-get install ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
# Add the repository to Apt sources:
echo \
"deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
"$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
```

Installation des packages :

```text-plain
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Test du bon fonctionnement de docker :

```text-plain
sudo docker run hello-world
```

L'output du container sera : hello world.

### Création des images

Pour la nous utiliserons Mongodb, voici le Dockerfile que nous avons définit :

```text-plain
FROM alpine:3.9
ENV TERM=linux
RUN apk add --no-cache bash mongodb
RUN mkdir -p /data/db && \
   chown -R mongodb /data/db
VOLUME /data/db
EXPOSE 27017
CMD [ "mongod", "--bind_ip", "0.0.0.0"]
```

Pour le backend nous utiliserons NodeJS, voici le Dockerfile que nous avons définit :

```text-plain
FROM alpine:3.18.4
RUN apk add --no-cache nodejs npm
WORKDIR /api
COPY api/package*.json ./
RUN npm install
RUN npm install -G mongoose cors
COPY /api /api
CMD ["npm", "start"]
EXPOSE 3070
```

Pour le frontend nous utiliserons ReactJS, voici le Dockerfile que nous avons définit :

```text-plain
FROM alpine:3.18.4
RUN apk add --no-cache nodejs npm
WORKDIR /react-docker
COPY react-docker/package*.json ./
RUN npm install
RUN npm install react-scripts
RUN npm build
COPY react-docker/ .
EXPOSE 3000
CMD ["npm", "start"]
```

### Build des images

Nous allons désormais build nos images a l'aide des commandes :

```text-plain
sudo docker image build -t db-image:latest .
sudo docker image build -t back-image:latest .
sudo docker image build -t front-image:latest .
```

### Test des images

Dans le cadre de test, nous pouvons aussi tester nos images pour voir si elles communique bien entre elles (bien-sur il faut prévoir au niveau du code du backend et du frontend que des appel/connections soit fait).

Pour cela nous pouvons temporairement faire un réseau pour que les images communiquent entre elles :

```text-plain
sudo docker network create -d bridge network
```

Nous pouvons lancer désormais chacun de nos conteneurs :

```text-plain
sudo docker run --name db --network network -p 27017:27017 -d db-image
sudo docker run --name back --network network -p 3070:3070 -d back-image
sudo docker run --name front --network network -p 3000:3000 -d front-image
```

Nous pouvons désormais communiquer en accédant a partir du front, au back et a la db.

Registry privée
---------------------------

Nous allons toujours rester sur la vm4 pour le moment, l'objectif est de generer des certificats auto-signé pour pouvoir pull les images d'un registry docker privée, car elle passent par défaut en TLS.

### Génération de clés :

Pour cela nous allons créer un dossier cert a la racine du repertoire de l'utilisateur :

```text-plain
cd
mkdir certs
cd cert
```

Nous allons définir un fichier de configuration pour OpenSSL :

```text-plain
[req]
default_bits = 4096
prompt = no
default_md = sha256
req_extensions = req_ext
distinguished_name = dn

[dn]
C=FR
ST=State
L=Location
O=Organization
OU=OrganizationalUnit
emailAddress=email@example.com
CN = private-registry.vm4.local

[req_ext]
subjectAltName = @alt_names
[alt_names]
DNS.1 = private-registry.vm4.local
IP.1 = <VM4-IP>
```

Ensuite, générez votre clé privée et le CSR en utilisant le fichier de configuration :

```text-plain
openssl req -new -nodes -newkey rsa:4096 -keyout domain.key -out domain.csr -config domain.ext
```

Enfin, signez le CSR pour créer votre certificat auto-signé :

```text-plain
openssl x509 -req -days 365 -in domain.csr -signkey domain.key -out domain.crt -extensions req_ext -extfile domain.ext
```

Vous pouvez vérifier que le certificat contient bien le SAN avec la commande suivante :

```text-plain
openssl x509 -text -noout -in domain.crt
```

Cherchez la section X509v3 extensions pour confirmer que le Subject Alternative Name est présent et correct.

### Lancement du conteneur

Vous pouvez lancer le docker registry privée a l'aide de cette commande :

```text-plain
docker run -d \
 -p 5000:5000 \
 --restart=always \
 --name registry \
 -v /home/user/certs:/certs \
 -e REGISTRY_HTTP_ADDR=0.0.0.0:5000 \
 -e REGISTRY_HTTP_TLS_CERTIFICATE=/certs/domain.crt \
 -e REGISTRY_HTTP_TLS_KEY=/certs/domain.key \
 registry:2
```

### Push les images

Rajouter le certificat dans docker pour pouvoir etre en mesure de push les images de facon sécuriser sur le registry :

```text-plain
sudo mkdir -p /etc/docker/certs.d/private-registry.vm4.local:5000
sudo cp /home/user/certs/domain.crt /etc/docker/certs.d/private-registry.vm4.local:5000/ca.crt
```

Redémarrer docker pour prendre en compte le certificat :

```text-plain
sudo systemctl restart docker
```

Maintenant pour push les images nous allons dans un premier temps tager l'image :

```text-plain
docker tag my-image localhost:5000/my-image
```

Et désormais pusher les images (pusher directement les trois que nous venons de build) :

```text-plain
docker push localhost:5000/my-image
```

Nous pouvons vérifier si nos images ont bien était push sur le registry a l'aide de la commande :

```text-plain
curl  -X GET https://private-registry.vm4.local:5000/v2/_catalog --cacert /etc/docker/certs.d/private-registry.vm4.local:5000/ca.crt
```

Maintenant que notre registry docker privée est mise en place nous pouvons passer a l'installation de Kubernetes sur les vm1, vm2 et vm3.

Étape IV : Installation et configuration du cluster Kubernetes
--------------------------------------------------------------

Pour commencer, rajouter dans le fichier /etc/hosts sur chacune des machines :

```text-plain
192.168.64.80 	k8s-master.vm1.local            k8s-master
192.168.64.81 	k8s-worker01.vm2.local          k8s-worker01
192.168.64.82   k8s-worker02.vm3.local          k8s-worker02
192.168.64.76   private-registry.vm4.local      private-registry
```

Pour que Kubernetes tourne sans probleme, nous allons désactiver le swap sur les machines virtuelles ou nous allons installer Kubernetes :

```text-plain
sudo swapoff -a
sudo sed -i '/ swap / s/^\(.*\)$/#\1/g' /etc/fstab
```

### Ouvertures des flux :

Installation du firewall :

```text-plain
sudo apt install ufw
```

Si vous utiliser SSH, n'oubliez pas d'ouvrir le port correspondant :

```text-plain
sudo ufw allow 22
```

Ouverture des ports sur la vm1 (k8s-master.vm1.local) :

```text-plain
sudo ufw allow 6443/tcp
sudo ufw allow 2379/tcp
sudo ufw allow 2380/tcp
sudo ufw allow 10250/tcp
sudo ufw allow 10251/tcp
sudo ufw allow 10252/tcp
sudo ufw allow 10255/tcp
```

Ouverture des ports sur la vm2 (k8s-worker01.vm2.local) et vm3 (k8s-worker02.vm3.local) :

```text-plain
sudo ufw allow 10250/tcp
sudo ufw allow 30000:32767/tcp
```

Activer le firewall :

```text-plain
sudo ufw enable
```

Recharger la configuration :

```text-plain
sudo ufw reload
```

### Installation de Containerd

Avant l'installation, modifier ces parametres de kernel sur tout les nodes :

```text-plain
cat <<EOF | sudo tee /etc/modules-load.d/containerd.conf 
overlay 
br_netfilter
EOF

sudo modprobe overlay

sudo modprobe br_netfilter

cat <<EOF | sudo tee /etc/sysctl.d/99-kubernetes-k8s.conf
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1 
net.bridge.bridge-nf-call-ip6tables = 1 
EOF
```

Pour que la modification soit pris en compte :

```text-plain
sudo sysctl --system
```

Maintenant, installer containerd avec les commandes suivante sur toute les nodes :

```text-plain
sudo apt update
sudo apt -y install containerd
```

Maintenant nous allons utiliser le fichier de configuration de containerd par defaut :

```text-plain
containerd config default | sudo tee /etc/containerd/config.toml >/dev/null 2>&1
```

Editer le fichier, et changer la partie ‘SystemdCgroup = false’ a ‘SystemdCgroup = true‘ :

```text-plain
sudo vim /etc/containerd/config.toml
```

Nous pouvons directement en profiter pour rajouter le certificat auto-signé du docker registry :

```text-plain
[plugins."io.containerd.grpc.v1.cri".registry.configs."private-registry.vm4.local:5000".tls]
 ca_file = "/etc/containerd/certs.d/private-registry.vm4.local:5000/ca.crt"
```

Copions le certificat a la bonne place :

```text-plain
sudo mkdir -p /etc/containerd/certs.d/private-registry.vm4.local:5000
sudo cp /chemin/vers/ca.crt /etc/containerd/certs.d/private-registry.vm4.local:5000/ca.crt
```

  
 

Redémarrons containerd et activons le au démarrage : 

```text-plain
sudo systemctl restart containerd
sudo systemctl enable containerd
```

### Installation de Kubernetes

L'installation est a faire sur tout les nodes

Ajout des repository :

```text-plain
sudo apt install gnupg gnupg2 curl software-properties-common -y
curl -s https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmour -o /etc/apt/trusted.gpg.d/cgoogle.gpg
sudo apt-add-repository "deb http://apt.kubernetes.io/ kubernetes-xenial main"
```

Installation des packages sur toute les nodes :

```text-plain
sudo apt update
sudo apt install kubelet kubeadm kubectl -y
```

On peut utiliser cette commande pour bloquer la mise a jour des packages :

```text-plain
sudo apt-mark hold kubelet kubeadm kubectl
```

Lancement du noeud master sur la vm1 (k8s-master.vm1.local) :

```text-plain
sudo kubeadm init --control-plane-endpoint=k8s-master
```

Si tout ce passe bien, vous aller avoir un retour qui ressemble a cela :

```text-plain
Your Kubernetes control-plane has initialized successfully!

To start using your cluster, you need to run the following as a regular user:
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

Alternatively, if you are the root user, you can run:
export KUBECONFIG=/etc/kubernetes/admin.conf

You should now deploy a pod network to the cluster.
Run "kubectl apply -f [podnetwork].yaml" with one of the options listed at:
https://kubernetes.io/docs/concepts/cluster-administration/addons/

You can now join any number of control-plane nodes by copying certificate authorities
and service account keys on each node and then running the following as root:

kubeadm join k8s-master:6443 --token 6a98t3.x5c7a7bh943dz9ws \
   --discovery-token-ca-cert-hash sha256:20ae3694915cca4d34911368144d9d9bcd145ea6c735d5ad577523ec28c8344d \
   --control-plane

Then you can join any number of worker nodes by running the following on each as root:
kubeadm join k8s-master:6443 --token 6a98t3.x5c7a7bh943dz9ws \
   --discovery-token-ca-cert-hash sha256:20ae3694915cca4d34911368144d9d9bcd145ea6c735d5ad577523ec28c8344d
```

Pour intéragir avec le cluster, lancer ces commandes :

```text-plain
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

Pour avoir des informations sur les nodes et le cluster en question :

```text-plain
kubectl get nodes
kubectl cluster-info
```

Pour lancer les workers node, a savoir dans notre cas la vm2 et vm3 lançons cette commande a partir de celle-ci (les tokens sont ceux fournit par kubeadm init) :

```text-plain
sudo kubeadm join k8s-master:6443 --token f9yrd7.wf1n3vsd7cwtd6p9 \
    --discovery-token-ca-cert-hash sha256:e2790093575b56118ca7b35744b1d4bb741b5a6b517717611cbbea3742368207
```

Pour verifier que les nodes ont bien était détecter :

```text-plain
kubectl get nodes
```

Pour que les pods puissent communiquer, nous allons utiliser un CNI (Container Network Interface), dans notre cas Calico :

```text-plain
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.26.1/manifests/calico.yaml
```

Vous pouvez verifier que les pods sont bien fonctionnelles :

```text-plain
kubectl get pods -n kube-system
```

A ce stade la, vos trois nodes sont censé etre “Ready”, pour verifier cela taper la commande :

```text-plain
kubectl get nodes
```

Étape V : Mise en place des pods
--------------------------------

Pour cette étape nous allons dans un premier temps, deployer seulement nos pods pour verifier que nos images et nos micro-services fonctionne bien.

Le fichier db-pod.yaml (pour le moment ne nous attardons par sur le persistentVolumeClaim, nous verrons cela par la suite) :

```text-plain
apiVersion: v1
kind: Pod
metadata:
 name: db-pod
 labels:
   app: mydatabase
spec:
 containers:
 - name: mongodb
   image: private-registry.vm4.local:5000/db-image
   ports:
   - containerPort: 27017
   volumeMounts:
   - name: mongodb-data
     mountPath: /data/db
 volumes:
 - name: mongodb-data
   persistentVolumeClaim:
     claimName: mongodb-data-pvc
```

Le fichier back-pod.yaml :

```text-plain
apiVersion: v1
kind: Pod
metadata:
 name: back-pod
 labels:
   app: mybackend
spec:
 containers:
 - name: api
   image: private-registry.vm4.local:5000/back-image:latest
   ports:
   - containerPort: 3070
```

Le fichier front-pod.yaml :

```text-plain
apiVersion: v1
kind: Pod
metadata:
 name: front-pod
 labels:
   app: myfrontend
spec:
 containers:
 - name: react
   image: private-registry.vm4.local:5000/front-image
   ports:
   - containerPort: 3000
```

Une fois que nos pods ont était penser et réfléchit, nous allons passer a leur déploiement.

Étape VI : Déploiements & Étape VII : Découverte de services
------------------------------------------------------------

Pour le déploiement, l'idée sera d'etre en mesure de gerer des version différentes et de definir le nombre de replicaset.

Pour cela nous avons définit.

Le fichier db-deployment :

```text-plain
apiVersion: apps/v1
kind: Deployment
metadata:
 name: db-deployment
 labels:
   app: db
spec:
 replicas: 1
 selector:
   matchLabels:
     app: db
 template:
   metadata:
     labels:
       app: db
   spec:
     containers:
     - name: mongodb
       image: private-registry.vm4.local:5000/db-image
       ports:
       - containerPort: 27017
       volumeMounts:
       - name: mongodb-data
         mountPath: /data/db
     volumes:
     - name: mongodb-data
       persistentVolumeClaim:
         claimName: mongodb-data-pvc
---
apiVersion: v1
kind: Service
metadata:
 name: mongodb-service
spec:
 selector:
   app: db
 ports:
   - protocol: TCP
     port: 27017
     targetPort: 27017
 type: ClusterIP
```

Le fichier back-deployment.yaml :

```text-plain
apiVersion: apps/v1
kind: Deployment
metadata:
 name: back-deployment
 labels:
   app: back
spec:
 replicas: 3
 selector:
   matchLabels:
     app: back
 template:
   metadata:
     labels:
       app: back
   spec:
     containers:
     - name: api
       image: private-registry.vm4.local:5000/back-image:latest
       ports:
       - containerPort: 3070
       env:
         - name: DATABASE_HOST
           value: mongodb-service
---
apiVersion: v1
kind: Service
metadata:
 name: back-service
spec:
 selector:
   app: back
 ports:
   - protocol: TCP
     port: 3070
     targetPort: 3070
     nodePort: 30070
 type: NodePort
```

Le fichier front-deployment.yaml :

```text-plain
apiVersion: apps/v1
kind: Deployment
metadata:
 name: front-deployment
 labels:
   app: front
spec:
 replicas: 3
 selector:
   matchLabels:
     app: front
 template:
   metadata:
     labels:
       app: front
   spec:
     containers:
     - name: react-app
       image: private-registry.vm4.local:5000/front-image
       ports:
       - containerPort: 3000
---
apiVersion: v1
kind: Service
metadata:
 name: front-service
spec:
 selector:
   app: front
 ports:
   - protocol: TCP
     port: 80
     targetPort: 3000
     nodePort: 30080
 type: NodePort
```

Par le biais des services, nous donnons la possibilité aux pods de communiquer entre-eux, et avec l'option NodePort, de pouvoir y acceder depuis l'exterieur du cluster. Par exemple nous pouvons désormais acceder a notre application ReactJS avec le lien : http:k8s-master:30080/.

### Étape VIII : Persistance des données

Pour configurer la persistances de données, nous devons configurer des PersistentVolume, pour cela nous avons définit un fichier, qui lancera trois PersistantVolume.

Le fichier mongodb-pvs.yaml :

```text-plain
apiVersion: v1
kind: PersistentVolume
metadata:
 name: mongodb-pv
 labels:
   type: local
spec:
 storageClassName: "my-local-storage"
 capacity:
   storage: 1Gi
 accessModes:
   - ReadWriteOnce
 hostPath:
   path: "/mnt/data/mongodb"
---
apiVersion: v1
kind: PersistentVolume
metadata:
 name: mongodb-pv-1
 labels:
   type: local
spec:
 storageClassName: "my-local-storage"
 capacity:
   storage: 1Gi
 accessModes:
   - ReadWriteOnce
 hostPath:
   path: "/mnt/data/mongodb-1"
---
apiVersion: v1
kind: PersistentVolume
metadata:
 name: mongodb-pv-2
 labels:
   type: local
spec:
 storageClassName: "my-local-storage"
 capacity:
   storage: 1Gi
 accessModes:
   - ReadWriteOnce
 hostPath:
   path: "/mnt/data/mongodb-2"
```

Lancer la commande pour créer les stockages persistants :

```text-plain
kubectl apply -f mongodb-pvs.yaml
```

Nous en définissons directement trois, car nous nous en servirons par la suite pour le “Statefulsets”. Vous remarquerez que nous définissons un storageClassName: "my-local-storage", il nous sera utilise pour la prochaine étape.

Cluster BDD
----------------------

Pour cette installation nous allons utiliser le concept de Statefulsets. Dans notre cas ce concept sera plus adapté car nous avons besoin que ces pods est une configuration réseau fixe avec un stockage persistant.

Le fichier mongodb-statefulset.yaml :

```text-plain
apiVersion: apps/v1
kind: StatefulSet
metadata:
 name: mongodb
spec:
 selector:
   matchLabels:
     app: mongodb
 serviceName: "mongodb"
 replicas: 3
 template:
   metadata:
     labels:
       app: mongodb
   spec:
     containers:
       - name: mongodb
         image: private-registry.vm4.local:5000/db-image
         ports:
           - containerPort: 27017
         volumeMounts:
           - name: mongo-data
             mountPath: /data/db
 volumeClaimTemplates:
 - metadata:
     name: mongo-data
   spec:
     accessModes: [ "ReadWriteOnce" ]
     storageClassName: "my-local-storage"
     resources:
       requests:
         storage: 1Gi
```

Ce fichier remplacera notre fichier de déploiement pour la db (db-deployment.yaml).

Lancer la commande pour lancer le Statefulset :

```text-plain
kubectl apply -f mongodb-statefulset.yaml 
```

Monitoring
--------------------

Des outils comme Prometheus, Grafana, et Alertmanager sont des choix populaires pour le monitoring de clusters Kubernetes.

Prometheus collecte et stocke ses métriques en tant que données de séries temporelles.  
\- Grafana est utilisé pour visualiser les données collectées par Prometheus.  
\- Alertmanager gère les alertes envoyées par les règles de client de Prometheus.

Le fichier de déploiement de Grafana (grafana-deployement.yaml) :

```text-plain
apiVersion: apps/v1
kind: Deployment
metadata:
 name: prometheus-deployment
spec:
 replicas: 1
 selector:
   matchLabels:
     app: prometheus
 template:
   metadata:
     labels:
       app: prometheus
   spec:
     containers:
     - name: prometheus
       image: prom/prometheus:v2.26.0
       ports:
       - containerPort: 9090
---
apiVersion: v1
kind: Service
metadata:
 name: prometheus-service
spec:
 selector:
   app: prometheus
 ports:
   - protocol: TCP
     port: 9090
     targetPort: 9090
     nodePort: 30090
 type: NodePort
```

Le fichier de déploiement de Prometheus (prometheus-deployement.yaml) :

```text-plain
apiVersion: apps/v1
kind: Deployment
metadata:
 name: prometheus-deployment
spec:
 replicas: 1
 selector:
   matchLabels:
     app: prometheus
 template:
   metadata:
     labels:
       app: prometheus
   spec:
     containers:
     - name: prometheus
       image: prom/prometheus:v2.26.0
       ports:
       - containerPort: 9090
---
apiVersion: v1
kind: Service
metadata:
 name: prometheus-service
spec:
 selector:
   app: prometheus
 ports:
   - protocol: TCP
     port: 9090
     targetPort: 9090
     nodePort: 30090
 type: NodePort
```

Après avoir déployé Grafana, vous pouvez configurer des tableaux de bord pour visualiser les métriques de Prometheus.

Vous devrez configurer les règles d'alerte dans Prometheus et ensuite configurer l'Alertmanager pour déterminer ce qu'il faut faire avec ces alertes.

Après la mise en place, vous devez vérifier que toutes les métriques sont correctement collectées et que les tableaux de bord reflètent les données en temps réel. Testez également les alertes pour vous assurer qu'elles sont déclenchées comme prévu.
