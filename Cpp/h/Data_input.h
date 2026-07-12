//
// Created by tise on 2026/6/4.
//


//只作为临时输入用途，后期换为实际输入
#ifndef HANDS_SEE_DATA_INPUT_H
#define HANDS_SEE_DATA_INPUT_H

#include <fstream>
#include <iostream>
#include "HandStruct.h"
#include "VectorNorm.h"

void Data_Input() {
    int f[10];
    float gyro[4];
    string name;
    int times=0;
    printf("name: ");
    cin>>name;
    printf("times: ");
    cin>>times;
    for (int j=0;j<times;j++) {
    ofstream fout;
    fout.open("Data_Record.json", ios::app);
    fout << "NAME_"<<name<<endl;
    fout << "TIMES_"<<j<<endl;
        fout.close();
        for (int i=0;i<10;i++) {
            printf("I%d=_",i);
            scanf("%d",&f[i]);
        }
        for (int i=0;i<4;i++) {
            printf("groy%d=_",i);
            scanf("%f",&gyro[i]);
        }
        HandStruct handStruct ;
        InputHandStruct(handStruct,f[0],f[1],f[2],f[3],f[4],f[5],f[6],f[7],f[8],f[9],gyro[0],gyro[1],gyro[2],gyro[3]);
        VectorResult Vtrl=calculate(handStruct);
        output(Vtrl);
        printf("have done [%d] times\n",j+1);
        printf("[%d] times left\n",times-j-1);
    }
    return;
}


#endif //HANDS_SEE_DATA_INPUT_H