import './serial.js'
import './test_panel.js'
import './labels.js'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js'
import GSAP from 'gsap'
import {Pane} from 'tweakpane'
import { initWebSocket } from './websocket_client.js';

// Pane
const pane = new Pane({
  container: document.getElementById('pane'),
})
const tab = pane.addTab({
  pages: [
    {title: '手部 🤟'},
    {title: '颜色 🎨'},
  ],
})
const clench = tab.pages[0].addFolder({
  title: '左手 握拳',
  expanded: false
});
const rightClench = tab.pages[0].addFolder({
  title: '右手 握拳',
  expanded: false
});
const PARAMS = {
  bg: 0x4b46b2,
  hand: 0xE7A183,
  shirt: 0x303030,
  vest: 0xE7D55C,
  wrist: 0,
  thumb: 0,
  index: 0,
  middle: 0,
  ring: 0,
  pinky: 0
}

const RIGHT_PARAMS = {
  wrist: 0,
  thumb: 0,
  index: 0,
  middle: 0,
  ring: 0,
  pinky: 0
}

const centerThresholdX = 10
const centerThresholdY = 20

const getRandomPosition = () => {
  const x = Math.random() * (100 - centerThresholdX * 2) + centerThresholdX
  const y = Math.random() * (100 - centerThresholdY * 2) + centerThresholdY
  return { x, y }
}

const getRandomRotation = () => {
  return Math.floor(Math.random() * 91) - 45;
}

const placeButtonRandomly = (button) => {
  const position = getRandomPosition()
  const rotation = getRandomRotation()
  button.style.left = `${position.x}%`
  button.style.top = `${position.y}%`
  button.style.transform = `rotate(${rotation}deg)`
}


// Canvas
const canvas = document.querySelector('canvas.webgl')

// Scene
const scene = new THREE.Scene()
const bgColor = new THREE.Color(PARAMS.bg)
scene.background = bgColor

tab.pages[1].addInput(PARAMS, 'bg', {
  view: 'color',
  picker: 'inline',
  expanded: false,
  label: '背景',
}).on('change', (ev) => {
  scene.background = new THREE.Color(ev.value)
  document.body.style.backgroundColor = ev.value;
})

/**
 * Model
 */
const gltfLoader = new GLTFLoader()

const leftHandGroup = new THREE.Group()
const rightHandGroup = new THREE.Group()
let rightHandMesh = null
let rightHandSkeleton = null

gltfLoader.load(
    'hand.glb',
    (gltf) =>
    {
      const leftHand = gltf.scene.children[0]
      leftHandGroup.add(leftHand)
      leftHandGroup.position.x = -1.8
      scene.add(leftHandGroup)

      setMaterials()
      setBones()
      loadRightHand()
    }
)

const loadRightHand = () => {
  gltfLoader.load(
    'righthand.glb',
    (gltf) =>
    {
      console.log('右手模型加载成功:', gltf)
      console.log('场景子节点:', gltf.scene.children)
      
      gltf.scene.traverse((child) => {
        console.log('子节点:', child.name)
        if (child.name === 'Hand') {
          child.name = 'RightHand'
          rightHandMesh = child
          rightHandSkeleton = child.skeleton
        } else if (child.name === 'Shirt') {
          child.name = 'RightShirt'
        } else if (child.name === 'Vest') {
          child.name = 'RightVest'
        }
      })

      const rightHand = gltf.scene.children[0]
      if (!rightHand) {
        console.error('右手模型子节点为空')
        return
      }
      rightHandGroup.add(rightHand)
      rightHandGroup.position.x = 1.8
      rightHandGroup.visible = true
      scene.add(rightHandGroup)

      console.log('右手模型已添加到场景:', rightHandGroup)
      console.log('右手位置:', rightHandGroup.position)

      setRightMaterials()
      setRightBones()
      initRightHandController()
    },
    undefined,
    (error) => {
      console.error('右手模型加载失败:', error)
    }
  )
}

// Materials
const handMaterial = new THREE.MeshToonMaterial()
const shirtMaterial = new THREE.MeshToonMaterial()
const vestMaterial = new THREE.MeshToonMaterial()

const setMaterials = () => {
  const textureLoader = new THREE.TextureLoader()
  const gradientTexture = textureLoader.load('3.jpg')
  gradientTexture.minFilter = THREE.NearestFilter
  gradientTexture.magFilter = THREE.NearestFilter
  gradientTexture.generateMipmaps = false

  handMaterial.color = new THREE.Color(PARAMS.hand)
  handMaterial.gradientMap = gradientTexture
  handMaterial.roughness = 0.7
  handMaterial.emissive = new THREE.Color(PARAMS.hand)
  handMaterial.emissiveIntensity = 0.2
  scene.getObjectByName('Hand').material = handMaterial

  shirtMaterial.color = new THREE.Color(PARAMS.shirt)
  shirtMaterial.gradientMap = gradientTexture
  scene.getObjectByName('Shirt').material = shirtMaterial

  vestMaterial.color = new THREE.Color(PARAMS.vest)
  vestMaterial.gradientMap = gradientTexture
  scene.getObjectByName('Vest').material = vestMaterial

  // Pane
  tab.pages[1].addInput(PARAMS, 'hand', {
    view: 'color',
    picker: 'inline',
    expanded: false,
    label: '手部',
  }).on('change', (ev) => {
    handMaterial.color = new THREE.Color(ev.value)
    handMaterial.emissive = new THREE.Color(PARAMS.hand)
    rightHandMaterial.color = new THREE.Color(ev.value)
    rightHandMaterial.emissive = new THREE.Color(PARAMS.hand)
  })
  tab.pages[1].addInput(PARAMS, 'shirt', {
    view: 'color',
    picker: 'inline',
    expanded: false,
    label: '衬衫',
  }).on('change', (ev) => {
    shirtMaterial.color = new THREE.Color(ev.value)
    rightShirtMaterial.color = new THREE.Color(ev.value)
  })
  tab.pages[1].addInput(PARAMS, 'vest', {
    view: 'color',
    picker: 'inline',
    expanded: false,
    label: '背心',
  }).on('change', (ev) => {
    vestMaterial.color = new THREE.Color(ev.value)
    rightVestMaterial.color = new THREE.Color(ev.value)
  })
}

const rightHandMaterial = new THREE.MeshToonMaterial()
const rightShirtMaterial = new THREE.MeshToonMaterial()
const rightVestMaterial = new THREE.MeshToonMaterial()

const setRightMaterials = () => {
  const textureLoader = new THREE.TextureLoader()
  const gradientTexture = textureLoader.load('3.jpg')
  gradientTexture.minFilter = THREE.NearestFilter
  gradientTexture.magFilter = THREE.NearestFilter
  gradientTexture.generateMipmaps = false

  rightHandMaterial.color = new THREE.Color(PARAMS.hand)
  rightHandMaterial.gradientMap = gradientTexture
  rightHandMaterial.roughness = 0.7
  rightHandMaterial.emissive = new THREE.Color(PARAMS.hand)
  rightHandMaterial.emissiveIntensity = 0.2
  scene.getObjectByName('RightHand').material = rightHandMaterial

  rightShirtMaterial.color = new THREE.Color(PARAMS.shirt)
  rightShirtMaterial.gradientMap = gradientTexture
  scene.getObjectByName('RightShirt').material = rightShirtMaterial

  rightVestMaterial.color = new THREE.Color(PARAMS.vest)
  rightVestMaterial.gradientMap = gradientTexture
  scene.getObjectByName('RightVest').material = rightVestMaterial
}

const setBones = () => {
  const wrist = scene.getObjectByName('Hand').skeleton.bones[0]
  const wrist1 = scene.getObjectByName('Hand').skeleton.bones[1]
  const wrist2 = scene.getObjectByName('Hand').skeleton.bones[2]
  const wrist3 = scene.getObjectByName('Hand').skeleton.bones[6]
  const wrist4 = scene.getObjectByName('Hand').skeleton.bones[10]
  const wrist5 = scene.getObjectByName('Hand').skeleton.bones[14]
  const wrist6 = scene.getObjectByName('Hand').skeleton.bones[18]
  wrist1.rotation.x = PARAMS.wrist
  wrist2.rotation.x = PARAMS.wrist
  wrist3.rotation.x = PARAMS.wrist
  wrist4.rotation.x = PARAMS.wrist
  wrist5.rotation.x = PARAMS.wrist
  wrist6.rotation.x = PARAMS.wrist

  const thumb1 = scene.getObjectByName('Hand').skeleton.bones[3]
  const thumb2 = scene.getObjectByName('Hand').skeleton.bones[4]
  const thumb3 = scene.getObjectByName('Hand').skeleton.bones[5]
  thumb1.rotation.x = PARAMS.thumb
  thumb2.rotation.x = PARAMS.thumb
  thumb3.rotation.x = PARAMS.thumb

  const index1 = scene.getObjectByName('Hand').skeleton.bones[7]
  const index2 = scene.getObjectByName('Hand').skeleton.bones[8]
  const index3 = scene.getObjectByName('Hand').skeleton.bones[9]
  index1.rotation.x = PARAMS.index
  index2.rotation.x = PARAMS.index
  index3.rotation.x = PARAMS.index

  const middle1 = scene.getObjectByName('Hand').skeleton.bones[11]
  const middle2 = scene.getObjectByName('Hand').skeleton.bones[12]
  const middle3 = scene.getObjectByName('Hand').skeleton.bones[13]
  middle1.rotation.x = PARAMS.middle
  middle2.rotation.x = PARAMS.middle
  middle3.rotation.x = PARAMS.middle

  const ring1 = scene.getObjectByName('Hand').skeleton.bones[15]
  const ring2 = scene.getObjectByName('Hand').skeleton.bones[16]
  const ring3 = scene.getObjectByName('Hand').skeleton.bones[17]
  ring1.rotation.x = PARAMS.ring
  ring2.rotation.x = PARAMS.ring
  ring3.rotation.x = PARAMS.ring

  const pinky1 = scene.getObjectByName('Hand').skeleton.bones[19]
  const pinky2 = scene.getObjectByName('Hand').skeleton.bones[20]
  const pinky3 = scene.getObjectByName('Hand').skeleton.bones[21]
  pinky1.rotation.x = PARAMS.pinky
  pinky2.rotation.x = PARAMS.pinky
  pinky3.rotation.x = PARAMS.pinky

  // PANE
  // Wrist
  clench.addInput(PARAMS, 'wrist', {min: -0.4, max: 0.4, step: 0.01, label: '手腕'})
      .on('change', (ev) => {
        wrist.rotation.x = (ev.value)
        wrist1.rotation.x = (ev.value)
        wrist2.rotation.x = (ev.value)
        wrist3.rotation.x = (ev.value)
        wrist4.rotation.x = (ev.value)
        wrist5.rotation.x = (ev.value)
        wrist6.rotation.x = (ev.value)
      })

  // Thumb
  clench.addInput(PARAMS, 'thumb', {min: 0, max: 0.9, step: 0.01, label: '拇指'})
      .on('change', (ev) => {
        thumb1.rotation.x = (ev.value)
        thumb2.rotation.x = (ev.value)
        thumb3.rotation.x = (ev.value)
      })

  // Index
  clench.addInput(PARAMS, 'index', {min: 0, max: 1.1, step: 0.01, label: '食指'})
      .on('change', (ev) => {
        index1.rotation.x = (ev.value)
        index2.rotation.x = (ev.value)
        index3.rotation.x = (ev.value)
      })

  // Middle
  clench.addInput(PARAMS, 'middle',
      {min: 0, max: 1.25, step: 0.01, label: '中指'}
  )
      .on('change', (ev) => {
        middle1.rotation.x = (ev.value)
        middle2.rotation.x = (ev.value)
        middle3.rotation.x = (ev.value)
      })

  // Ring
  clench.addInput(PARAMS, 'ring', {min: 0, max: 1.25, step: 0.01, label: '无名指'})
      .on('change', (ev) => {
        ring1.rotation.x = (ev.value)
        ring2.rotation.x = (ev.value)
        ring3.rotation.x = (ev.value)
      })

  const syncLeftHand = () => {
    wrist1.rotation.x = PARAMS.wrist
    wrist2.rotation.x = PARAMS.wrist
    wrist3.rotation.x = PARAMS.wrist
    wrist4.rotation.x = PARAMS.wrist
    wrist5.rotation.x = PARAMS.wrist
    wrist6.rotation.x = PARAMS.wrist

    thumb1.rotation.x = PARAMS.thumb
    thumb2.rotation.x = PARAMS.thumb
    thumb3.rotation.x = PARAMS.thumb

    index1.rotation.x = PARAMS.index
    index2.rotation.x = PARAMS.index
    index3.rotation.x = PARAMS.index

    middle1.rotation.x = PARAMS.middle
    middle2.rotation.x = PARAMS.middle
    middle3.rotation.x = PARAMS.middle

    ring1.rotation.x = PARAMS.ring
    ring2.rotation.x = PARAMS.ring
    ring3.rotation.x = PARAMS.ring

    pinky1.rotation.x = PARAMS.pinky
    pinky2.rotation.x = PARAMS.pinky
    pinky3.rotation.x = PARAMS.pinky
  }

  // Pinky
  clench.addInput(PARAMS, 'pinky', {min: 0, max: 1.15, step: 0.01, label: '小指'})
      .on('change', (ev) => {
        pinky1.rotation.x = (ev.value)
        pinky2.rotation.x = (ev.value)
        pinky3.rotation.x = (ev.value)
      })

  window.leftBonesSync = syncLeftHand
  }

const setRightBones = () => {
  const bones = rightHandSkeleton.bones

  const rightWrist = bones[0]
  const rightWrist1 = bones[1]
  const rightWrist2 = bones[2]
  const rightWrist3 = bones[6]
  const rightWrist4 = bones[10]
  const rightWrist5 = bones[14]
  const rightWrist6 = bones[18]
  rightWrist.rotation.x = RIGHT_PARAMS.wrist
  rightWrist1.rotation.x = RIGHT_PARAMS.wrist
  rightWrist2.rotation.x = RIGHT_PARAMS.wrist
  rightWrist3.rotation.x = RIGHT_PARAMS.wrist
  rightWrist4.rotation.x = RIGHT_PARAMS.wrist
  rightWrist5.rotation.x = RIGHT_PARAMS.wrist
  rightWrist6.rotation.x = RIGHT_PARAMS.wrist

  const rightThumb1 = bones[3]
  const rightThumb2 = bones[4]
  const rightThumb3 = bones[5]
  rightThumb1.rotation.x = RIGHT_PARAMS.thumb
  rightThumb2.rotation.x = RIGHT_PARAMS.thumb
  rightThumb3.rotation.x = RIGHT_PARAMS.thumb

  const rightIndex1 = bones[7]
  const rightIndex2 = bones[8]
  const rightIndex3 = bones[9]
  rightIndex1.rotation.x = RIGHT_PARAMS.index
  rightIndex2.rotation.x = RIGHT_PARAMS.index
  rightIndex3.rotation.x = RIGHT_PARAMS.index

  const rightMiddle1 = bones[11]
  const rightMiddle2 = bones[12]
  const rightMiddle3 = bones[13]
  rightMiddle1.rotation.x = RIGHT_PARAMS.middle
  rightMiddle2.rotation.x = RIGHT_PARAMS.middle
  rightMiddle3.rotation.x = RIGHT_PARAMS.middle

  const rightRing1 = bones[15]
  const rightRing2 = bones[16]
  const rightRing3 = bones[17]
  rightRing1.rotation.x = RIGHT_PARAMS.ring
  rightRing2.rotation.x = RIGHT_PARAMS.ring
  rightRing3.rotation.x = RIGHT_PARAMS.ring

  const rightPinky1 = bones[19]
  const rightPinky2 = bones[20]
  const rightPinky3 = bones[21]
  rightPinky1.rotation.x = RIGHT_PARAMS.pinky
  rightPinky2.rotation.x = RIGHT_PARAMS.pinky
  rightPinky3.rotation.x = RIGHT_PARAMS.pinky

  const syncRightHand = () => {
    rightWrist.rotation.x = RIGHT_PARAMS.wrist
    rightWrist1.rotation.x = RIGHT_PARAMS.wrist
    rightWrist2.rotation.x = RIGHT_PARAMS.wrist
    rightWrist3.rotation.x = RIGHT_PARAMS.wrist
    rightWrist4.rotation.x = RIGHT_PARAMS.wrist
    rightWrist5.rotation.x = RIGHT_PARAMS.wrist
    rightWrist6.rotation.x = RIGHT_PARAMS.wrist

    rightThumb1.rotation.x = RIGHT_PARAMS.thumb
    rightThumb2.rotation.x = RIGHT_PARAMS.thumb
    rightThumb3.rotation.x = RIGHT_PARAMS.thumb

    rightIndex1.rotation.x = RIGHT_PARAMS.index
    rightIndex2.rotation.x = RIGHT_PARAMS.index
    rightIndex3.rotation.x = RIGHT_PARAMS.index

    rightMiddle1.rotation.x = RIGHT_PARAMS.middle
    rightMiddle2.rotation.x = RIGHT_PARAMS.middle
    rightMiddle3.rotation.x = RIGHT_PARAMS.middle

    rightRing1.rotation.x = RIGHT_PARAMS.ring
    rightRing2.rotation.x = RIGHT_PARAMS.ring
    rightRing3.rotation.x = RIGHT_PARAMS.ring

    rightPinky1.rotation.x = RIGHT_PARAMS.pinky
    rightPinky2.rotation.x = RIGHT_PARAMS.pinky
    rightPinky3.rotation.x = RIGHT_PARAMS.pinky
  }

  rightClench.addInput(RIGHT_PARAMS, 'wrist', {min: -0.4, max: 0.4, step: 0.01, label: '手腕'})
      .on('change', syncRightHand)

  rightClench.addInput(RIGHT_PARAMS, 'thumb', {min: 0, max: 0.9, step: 0.01, label: '拇指'})
      .on('change', syncRightHand)

  rightClench.addInput(RIGHT_PARAMS, 'index', {min: 0, max: 1.1, step: 0.01, label: '食指'})
      .on('change', syncRightHand)

  rightClench.addInput(RIGHT_PARAMS, 'middle', {min: 0, max: 1.25, step: 0.01, label: '中指'})
      .on('change', syncRightHand)

  rightClench.addInput(RIGHT_PARAMS, 'ring', {min: 0, max: 1.25, step: 0.01, label: '无名指'})
      .on('change', syncRightHand)

  rightClench.addInput(RIGHT_PARAMS, 'pinky', {min: 0, max: 1.15, step: 0.01, label: '小指'})
      .on('change', syncRightHand)

  window.rightBonesSync = syncRightHand
}

const initRightHandController = () => {
  window.rightHandController = {
    show: () => {
      rightHandGroup.visible = true
    },
    hide: () => {
      rightHandGroup.visible = false
    },
    toggle: () => {
      rightHandGroup.visible = !rightHandGroup.visible
      return rightHandGroup.visible
    },
    setPosition: (x, y, z) => {
      rightHandGroup.position.set(x, y, z)
    },
    setScale: (scale) => {
      rightHandGroup.scale.set(scale, scale, scale)
    },
    setRotation: (x, y, z) => {
      rightHandGroup.rotation.set(x, y, z)
    },
    setPose: (fingerData) => {
      if (!rightHandSkeleton) return
      const bones = rightHandSkeleton.bones
      const boneMap = {
        thumb: [3, 4, 5],
        index: [7, 8, 9],
        middle: [11, 12, 13],
        ring: [15, 16, 17],
        pinky: [19, 20, 21],
      }
      for (const [key, indices] of Object.entries(boneMap)) {
        const val = fingerData[key] || 0
        for (const idx of indices) {
          if (bones[idx]) bones[idx].rotation.x = val
        }
      }
    },
    setWristRotation: (x) => {
      if (!rightHandSkeleton) return
      const bones = rightHandSkeleton.bones
      const wristIndices = [1, 2, 6, 10, 14, 18]
      for (const idx of wristIndices) {
        if (bones[idx]) bones[idx].rotation.x = x
      }
    },
    syncWithLeft: () => {
      RIGHT_PARAMS.wrist = PARAMS.wrist
      RIGHT_PARAMS.thumb = PARAMS.thumb
      RIGHT_PARAMS.index = PARAMS.index
      RIGHT_PARAMS.middle = PARAMS.middle
      RIGHT_PARAMS.ring = PARAMS.ring
      RIGHT_PARAMS.pinky = PARAMS.pinky
      if (window.rightBonesSync) {
        window.rightBonesSync()
      }
    },
    getVisible: () => rightHandGroup.visible,
    getPosition: () => ({ x: rightHandGroup.position.x, y: rightHandGroup.position.y, z: rightHandGroup.position.z }),
    getSkeleton: () => rightHandSkeleton,
    getMesh: () => rightHandMesh,
    getGroup: () => rightHandGroup
  }

  console.log('右手控制器已初始化')
}

/**
 * Lights
 */
const ambientLight = new THREE.AmbientLight(0xffffff, 0.3)
scene.add(ambientLight)

const directionalLight = new THREE.DirectionalLight(0xffffff, 2)
directionalLight.position.set(-5, 5, 5)
directionalLight.scale.set(0.5, 0.5, 0.5)
scene.add(directionalLight)

/**
 * Sizes
 */
const sizes = {
  width: window.innerWidth,
  height: window.innerHeight
}

window.addEventListener('resize', () =>
{
  // Update sizes
  sizes.width = window.innerWidth
  sizes.height = window.innerHeight

  // Update camera
  camera.aspect = sizes.width / sizes.height
  camera.updateProjectionMatrix()

  // Update renderer
  outlineEffect.setSize(sizes.width, sizes.height)
  outlineEffect.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
})

/**
 * Camera
 */
const camera = new THREE.PerspectiveCamera(75, sizes.width / sizes.height, 0.1, 100)
camera.position.set(0, 0, 5)
scene.add(camera)

// Controls
const controls = new OrbitControls(camera, canvas)
controls.target.set(0, 0, 0)
controls.enableDamping = true
controls.maxPolarAngle = Math.PI / 2
controls.minDistance = 3
controls.maxDistance = 10

/**
 * Renderer
 */
const renderer = new THREE.WebGLRenderer({
  canvas: canvas,
  alpha: true,
  antialias: false,
  powerPreference: 'high-performance'
})
renderer.shadowMap.enabled = false
renderer.setSize(sizes.width, sizes.height)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))

const outlineEffect = new OutlineEffect(renderer, {
  defaultThickness: 0.0035,
  defaultColor: [ 0, 0, 0 ],
  defaultAlpha: 0.8,
  defaultKeepAlive: true
})

/**
 * Animate
 */
const clock = new THREE.Clock()
let previousTime = 0

const tick = () =>
{
  const elapsedTime = clock.getElapsedTime()
  const deltaTime = elapsedTime - previousTime
  previousTime = elapsedTime

  // Update controls
  controls.update()

  // Render
  outlineEffect.render(scene, camera)

  // Call tick again on the next frame
  window.requestAnimationFrame(tick)
}

tick()

// 将关键对象暴露到全局，供串口脚本使用
window.Re = PARAMS;          // 左手手指数据，用于更新面板显示
window.We = scene;           // Three.js 场景，用于查找骨骼
window.Vi = pane;            // Tweakpane 实例，用于刷新 UI
window.PARAMS = PARAMS;      // 左手参数
window.RIGHT_PARAMS = RIGHT_PARAMS;  // 右手参数，供串口脚本独立控制
console.log('目标暴露成功，可使用串口修改');

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initWebSocket();
    });
} else {
    initWebSocket();
}